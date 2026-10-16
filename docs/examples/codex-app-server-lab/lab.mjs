/** Bounded stdio JSON-RPC harness. Raw protocol bodies stay in memory, never in logs. */
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";

const DELTA = "item/agentMessage/delta";
const METHODS = new Set([
  "initialize", "initialized", "model/list", "getAuthStatus", "account/read",
  "thread/list", "thread/start", "thread/resume", "thread/read", "thread/unsubscribe",
  "thread/turns/list", "thread/items/list", "thread/started", "thread/status/changed",
  "turn/start", "turn/steer", "turn/interrupt", "turn/started", "turn/completed",
  "item/started", "item/completed", DELTA, "item/commandExecution/outputDelta",
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput", "item/tool/call",
  "execCommandApproval", "applyPatchApproval", "mcpServer/elicitation/request",
  "account/chatgptAuthTokens/refresh", "attestation/generate", "serverRequest/resolved",
  "error", "account/updated", "account/rateLimits/updated", "thread/tokenUsage/updated",
  "experimentalFeature/list", "permissionProfile/list", "mcpServer/startupStatus/updated",
  "skills/changed", "deprecationNotice", "warning",
]);
const STATUSES = new Set(["idle", "active", "notLoaded", "systemError", "inProgress", "completed", "interrupted", "failed", "declined"]);
const ITEM_TYPES = new Set(["agentMessage", "userMessage", "commandExecution", "fileChange", "reasoning", "plan", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "contextCompaction"]);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
const methodName = (value) => METHODS.has(value) ? value : "<unknown>";

export function labError(code, rpcCode) {
  return Object.assign(new Error(code), { code, ...(Number.isInteger(rpcCode) ? { rpcCode } : {}) });
}

/** Deliberately omits command, text, token, error.message, paths and arbitrary response fields. */
export function safeMetadata(value = {}) {
  const result = {};
  if (value.method) result.method = methodName(value.method);
  for (const key of ["threadId", "turnId", "itemId"]) if (id(value[key])) result[key] = value[key];
  for (const key of ["id", "seq", "count", "bytes", "code", "rpcCode", "signal", "pending", "waiters"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  }
  if (STATUSES.has(value.status)) result.status = value.status;
  if (ITEM_TYPES.has(value.itemType)) result.itemType = value.itemType;
  if (typeof value.willRetry === "boolean") result.willRetry = value.willRetry;
  if (typeof value.truncated === "boolean") result.truncated = value.truncated;
  return result;
}

export function safeError(error) {
  const known = /^[A-Z][A-Z0-9_]{0,63}$/;
  return { code: known.test(error?.code ?? "") ? error.code : "ASSERTION_OR_RUN_FAILED", ...(Number.isInteger(error?.rpcCode) ? { rpcCode: error.rpcCode } : {}) };
}

export const UNSUPPORTED = Symbol("explicit unsupported response; do not invent a user answer");
export const text = (value) => ({ type: "text", text: value, text_elements: [] });

export class AppServer {
  constructor({
    label = "lab", spawn = nodeSpawn, cwd = tmpdir(), env = process.env,
    log = (event, meta) => console.log(`[${label}] ${event} ${JSON.stringify(meta)}`),
    args = [], bin = "codex", limits = {},
  } = {}) {
    this.spawn = spawn;
    this.cwd = cwd;
    this.env = { ...env };
    this.bin = bin;
    this.args = [...args];
    this.logger = log;
    this.limits = {
      messageBytes: 2 * 1024 * 1024, historyBytes: 8 * 1024 * 1024,
      history: 512, pending: 64, waiters: 64, serverRequests: 32,
      deltaChars: 64 * 1024, requestMs: 60_000, handlerMs: 30_000, closeMs: 1000,
      ...limits,
    };
    for (const value of Object.values(this.limits)) if (!Number.isFinite(value) || value <= 0) throw labError("INVALID_LIMIT");
    this.pending = new Map();
    this.waiters = new Set();
    this.handlers = new Map();
    this.history = [];
    this.historyBytes = 0;
    this.droppedEvents = 0;
    this.nextId = 1;
    this.sequence = 0;
    this.buf = "";
    this.decoder = new StringDecoder("utf8");
    this.stderrBytes = 0;
    this.child = null;
    this.exitInfo = null;
    this.failure = null;
    this.unsupportedRequests = 0;
    this.onServerRequest = null;
  }

  get cursor() { return this.sequence; }
  get events() { return this.history.filter((event) => event.kind === "notification"); }
  get serverRequests() { return this.history.filter((event) => event.kind === "serverRequest"); }
  log(event, metadata = {}) { this.logger(event, safeMetadata(metadata)); }

  start() {
    if (this.child || this.failure || this.exitInfo) throw labError("ALREADY_STARTED");
    this.closed = new Promise((resolve) => { this._closed = resolve; });
    try {
      this.child = this.spawn(this.bin, ["app-server", ...this.args], {
        stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd, env: this.env,
      });
      this.child.stdout.on("data", (chunk) => this._feed(chunk));
      this.child.stdout.on("end", () => this._end());
      this.child.stdout.on("error", () => this._abort(labError("STDOUT_ERROR")));
      this.child.stderr.on("data", (chunk) => { this.stderrBytes += chunk.length; });
      this.child.stderr.on("error", () => this._abort(labError("STDERR_ERROR")));
      this.child.stdin.on("error", () => this._abort(labError("STDIN_ERROR")));
      this.child.on("error", () => this._abort(labError("SPAWN_ERROR")));
      this.child.on("close", (code, signal) => {
        this._end();
        this.exitInfo = { code, signal };
        if (!this.closing) this._abort(labError("PROCESS_CLOSED"), false);
        this._closed(this.exitInfo);
        this.log("process_closed", { code });
      });
    } catch {
      this._abort(labError("SPAWN_ERROR"), false);
      this.exitInfo = { code: null, signal: null };
      this._closed(this.exitInfo);
    }
    return this;
  }

  async initialize({ experimentalApi = false, clientInfo } = {}) {
    const result = await this.request("initialize", {
      clientInfo: clientInfo ?? { name: "agent-hub-lab", title: "Codex protocol lab", version: "0.1.0" },
      ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
    });
    await this.notify("initialized");
    return result;
  }

  _feed(chunk) {
    if (this.ended || this.failure) return;
    this.buf += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this._lines(false);
  }

  _end() {
    if (this.ended) return;
    this.ended = true;
    this.buf += this.decoder.end();
    this._lines(true);
  }

  _lines(flush) {
    while (!this.failure) {
      const end = this.buf.indexOf("\n");
      if (end < 0 && !flush) break;
      const line = end < 0 ? this.buf : this.buf.slice(0, end);
      this.buf = end < 0 ? "" : this.buf.slice(end + 1);
      if (Buffer.byteLength(line) > this.limits.messageBytes) return this._abort(labError("MESSAGE_LIMIT"));
      if (line.trim()) {
        try { this._dispatch(JSON.parse(line)); }
        catch { return this._abort(labError("INVALID_PROTOCOL")); }
      }
      if (end < 0) break;
    }
    if (Buffer.byteLength(this.buf) > this.limits.messageBytes) this._abort(labError("MESSAGE_LIMIT"));
  }

  _dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")) return this._abort(labError("INVALID_PROTOCOL"));
    if (has(message, "id") && !(typeof message.id === "string" || (typeof message.id === "number" && Number.isFinite(message.id)))) return this._abort(labError("INVALID_PROTOCOL"));
    if (has(message, "result") && has(message, "error")) return this._abort(labError("INVALID_PROTOCOL"));
    if (has(message, "id") && (has(message, "result") || has(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return this._abort(labError("UNEXPECTED_RESPONSE"));
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const failure = labError("RPC_ERROR", message.error.code);
        // Classification is local; the server's free-form error body is never exported.
        if (/already has an active writer/i.test(message.error.message ?? "")) failure.rpcReason = "active_writer";
        else if (/thread not found|thread not loaded/i.test(message.error.message ?? "")) failure.rpcReason = "thread_not_loaded";
        pending.reject(failure);
      }
      else pending.resolve(message.result);
      this.log("response", { method: pending.method, id: message.id, rpcCode: message.error?.code });
      return;
    }
    if (typeof message.method !== "string" || has(message, "result") || has(message, "error")) return this._abort(labError("INVALID_PROTOCOL"));
    const params = message.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) return this._abort(labError("INVALID_PROTOCOL"));
    const event = {
      seq: ++this.sequence, ms: Date.now(), kind: has(message, "id") ? "serverRequest" : "notification",
      method: message.method, params, ...(has(message, "id") ? { id: message.id } : {}),
      threadId: params.threadId ?? params.thread?.id,
      turnId: params.turnId ?? params.turn?.id,
      itemId: params.itemId ?? params.item?.id,
      count: 1, consumed: false,
    };
    this._remember(event);
    if (event.method !== DELTA) this.log(event.kind, this._summary(event));
    for (const waiter of [...this.waiters]) {
      try {
        if (!this._matches(waiter, event)) continue;
        this._settleWaiter(waiter, null, event);
        if (waiter.consume) { event.consumed = true; break; }
      } catch { this._settleWaiter(waiter, labError("PREDICATE_ERROR")); }
    }
    if (event.kind === "serverRequest") void this._serve(message);
  }

  _summary(event) {
    return safeMetadata({ ...event, status: event.params.turn?.status ?? event.params.status?.type ?? event.params.item?.status,
      itemType: event.params.item?.type, bytes: typeof event.params.delta === "string" ? Buffer.byteLength(event.params.delta) : undefined,
      willRetry: event.params.willRetry });
  }

  _remember(event) {
    const last = this.history.at(-1);
    if (event.method === DELTA && last?.method === DELTA && last.threadId === event.threadId && last.turnId === event.turnId && last.itemId === event.itemId) {
      this.historyBytes -= last.size;
      const delta = String(last.params.delta ?? "") + String(event.params.delta ?? "");
      event.params = { ...event.params, delta: delta.slice(-this.limits.deltaChars) };
      event.count += last.count;
      event.truncated = last.truncated || delta.length > this.limits.deltaChars;
      this.history.pop();
    }
    event.size = Buffer.byteLength(JSON.stringify(event.params));
    this.history.push(event);
    this.historyBytes += event.size;
    while (this.history.length > this.limits.history || this.historyBytes > this.limits.historyBytes) {
      this.historyBytes -= this.history.shift().size;
      this.droppedEvents += 1;
    }
  }

  async _serve(message) {
    if (this.handlers.has(message.id) || this.handlers.size >= this.limits.serverRequests) return this._abort(labError("SERVER_REQUEST_LIMIT"));
    const active = { done: false };
    active.finished = new Promise((resolve) => { active.finish = resolve; });
    active.timer = setTimeout(() => this._abort(labError("SERVER_HANDLER_TIMEOUT")), this.limits.handlerMs);
    this.handlers.set(message.id, active);
    try {
      const result = await this.onServerRequest?.(message.method, message.params ?? {}, this);
      if (active.done || this.failure || this.closing) return;
      if (result === undefined || result === UNSUPPORTED) {
        this.unsupportedRequests += 1;
        await this._write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
        if (result !== UNSUPPORTED) this._abort(labError("UNKNOWN_SERVER_REQUEST"));
      } else {
        await this.reply(message.id, result);
      }
    } catch {
      if (!this.failure && !this.closing) {
        await this._write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Client handler failed" } }).catch(() => {});
        this._abort(labError("SERVER_HANDLER_ERROR"));
      }
    } finally {
      active.done = true;
      clearTimeout(active.timer);
      this.handlers.delete(message.id);
      active.finish();
    }
  }

  _write(message) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child || this.exitInfo || this.closing || this.child.stdin.destroyed) return Promise.reject(labError("PROCESS_NOT_WRITABLE"));
    return new Promise((resolve, reject) => {
      try {
        this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
          if (error) { const failure = labError("WRITE_ERROR"); reject(failure); this._abort(failure); }
          else resolve();
        });
      } catch { reject(labError("WRITE_ERROR")); }
    });
  }

  reply(requestId, result) {
    if (result && typeof result.then === "function") return Promise.reject(labError("PROMISE_RESPONSE"));
    return this._write({ jsonrpc: "2.0", id: requestId, result });
  }
  notify(method, params) { return this._write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); }

  request(method, params, timeoutMs = this.limits.requestMs) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.limits.pending) return Promise.reject(labError("PENDING_LIMIT"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(labError("INVALID_TIMEOUT"));
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._abort(labError("REQUEST_TIMEOUT")), timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
      this.log("request", { method, id: requestId });
      void this._write({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) }).catch((error) => this._abort(error));
    });
  }

  /** New events by default; use a captured `after` cursor to include races after turn/start. */
  waitFor(methodOrPredicate, { threadId, turnId, after = this.cursor, timeoutMs = this.limits.requestMs, consume = true } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(labError("INVALID_TIMEOUT"));
    if (typeof methodOrPredicate !== "string" && typeof methodOrPredicate !== "function") return Promise.reject(labError("INVALID_PREDICATE"));
    if (typeof methodOrPredicate === "string" && /^(turn|item)\//.test(methodOrPredicate) && (!threadId || !turnId)) return Promise.reject(labError("EVENT_SCOPE_REQUIRED"));
    return new Promise((resolve, reject) => {
      const waiter = { threadId, turnId, after, consume, resolve, reject,
        pred: typeof methodOrPredicate === "string" ? (event) => event.method === methodOrPredicate : methodOrPredicate };
      try {
        const hit = this.history.find((event) => this._matches(waiter, event));
        if (hit) { if (consume) hit.consumed = true; resolve(hit); return; }
      } catch { reject(labError("PREDICATE_ERROR")); return; }
      if (this.waiters.size >= this.limits.waiters) { reject(labError("WAITER_LIMIT")); return; }
      waiter.timer = setTimeout(() => this._abort(labError("WAIT_TIMEOUT")), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  _matches(waiter, event) {
    return event.seq > waiter.after && (!waiter.consume || !event.consumed)
      && (!waiter.threadId || waiter.threadId === event.threadId)
      && (!waiter.turnId || waiter.turnId === event.turnId) && waiter.pred(event) === true;
  }
  _settleWaiter(waiter, error, event) {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    if (error) waiter.reject(error); else waiter.resolve(event);
  }

  _abort(error, kill = true) {
    this.failure ??= error;
    this.buf = "";
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    for (const waiter of [...this.waiters]) this._settleWaiter(waiter, this.failure);
    for (const active of this.handlers.values()) { active.done = true; clearTimeout(active.timer); active.finish(); }
    this.handlers.clear();
    this.log("failure", { code: error.rpcCode });
    if (kill && this.child && !this.exitInfo && !this.closing) this.child.kill("SIGTERM");
  }

  async settleHandlers() { await Promise.all([...this.handlers.values()].map((active) => active.finished)); }
  assertHealthy() {
    if (this.failure) throw this.failure;
    if (this.handlers.size) throw labError("SERVER_HANDLERS_PENDING");
  }
  timeline() { return this.history.map((event) => this._summary(event)); }

  async close() {
    if (this._closingPromise) return this._closingPromise;
    this._closingPromise = this._close();
    return this._closingPromise;
  }

  async _close() {
    this.closing = true;
    if (!this.child || this.exitInfo) return;
    this._abort(labError("CLIENT_CLOSED"), false);
    this.child.kill("SIGTERM");
    const wait = () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.limits.closeMs);
      this.closed.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (await wait()) return;
    this.child.kill("SIGKILL");
    if (!await wait()) throw labError("CLOSE_TIMEOUT");
  }
}
