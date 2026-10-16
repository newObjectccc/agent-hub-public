/**
 * codex app-server JSON-RPC 实验 harness（agent-hub X2–X7 验证用，只在 /tmp 沙箱跑）
 * - 长驻 `codex app-server`（stdio://），行缓冲 JSON-RPC 2.0
 * - request(method, params) → Promise（result / 抛 error）
 * - ServerRequest（server→client，带 id）交给 handler 应答；返回 undefined = 故意挂起（测超时/别处解决）
 * - 事件精简记录：连续 agentMessageDelta 合并计数，绝不打印全文（防日志爆炸）
 */
import { spawn } from "node:child_process";

const t0 = Date.now();
const ms = () => Date.now() - t0;

/** 通知 → 一行摘要（只留决策需要的字段） */
function brief(method, params) {
  const p = params ?? {};
  const item = p.item ?? null;
  const base = { turn: (p.turnId ?? p.turn?.id ?? "").slice(-6) || undefined };
  switch (method) {
    case "item/started":
    case "item/completed":
      return `${item?.type ?? "?"}#${String(item?.id ?? "").slice(-6)}${
        item?.status ? ` status=${item.status}` : ""
      }${item?.command ? ` cmd=${JSON.stringify(item.command).slice(0, 90)}` : ""}${
        item?.type === "agentMessage" ? ` text=${JSON.stringify(item.text ?? "").slice(0, 120)}` : ""
      }`;
    case "agentMessageDelta":
      return `delta(${String(p.delta ?? "").length})`;
    case "turn/started":
    case "turn/completed":
      return `turn#${String(p.turn?.id ?? "").slice(-6)} status=${p.turn?.status ?? "?"} items=${p.turn?.items?.length ?? 0}${
        p.turn?.error ? ` error=${JSON.stringify(p.turn.error).slice(0, 200)}` : ""
      }`;
    case "error":
      return JSON.stringify(p).slice(0, 300);
    default:
      return JSON.stringify(p).slice(0, 180);
  }
}

export class AppServer {
  constructor({ label = "as", verbose = false, env = null, args = null, bin = null } = {}) {
    this.label = label;
    this.envOverride = env;
    this.extraArgs = args ?? [];
    this.bin = bin ?? "codex";
    this.verbose = verbose;
    this.events = [];          // {ms, method, brief}
    this.serverRequests = [];  // {ms, method, params, id}
    this.pending = new Map();  // id → {resolve, reject, timer}
    this.nextId = 1;
    this.waiters = [];         // {pred, resolve, timer}
    this.child = null;
    this.buf = "";
    this.stderrTail = "";
    this.exitInfo = null;
    /** (method, params, reply) => response|undefined；undefined = 挂起不应答 */
    this.onServerRequest = null;
  }

  log(...args) {
    console.log(`[${ms()}ms][${this.label}]`, ...args);
  }

  start() {
    this.child = spawn(this.bin, ["app-server", ...this.extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.envOverride ? { ...process.env, ...this.envOverride } : process.env,
      cwd: "/tmp/codex-lab",
    });
    this.child.stdout.on("data", (d) => this._feed(d));
    this.child.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-800);
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.log(`EXIT code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(new Error("app-server exited"));
      this.pending.clear();
      for (const w of this.waiters) w.resolve(null);
      this.waiters = [];
    });
    return this;
  }

  _feed(chunk) {
    this.buf += String(chunk);
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log("NON-JSON:", line.slice(0, 200));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 1) response to our request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { rpc: msg.error }));
        else p.resolve(msg.result);
      } else {
        this.log(`ORPHAN-RESPONSE id=${msg.id}`, JSON.stringify(msg).slice(0, 200));
      }
      return;
    }
    // 2) server→client request（需应答）
    if (msg.id !== undefined && typeof msg.method === "string") {
      this.serverRequests.push({ ms: ms(), method: msg.method, params: msg.params, id: msg.id });
      this.log(`<<SERVER-REQUEST ${msg.method} id=${msg.id}`, JSON.stringify(msg.params).slice(0, 500));
      this._notifyWaiters(msg.method, msg.params, msg.id);
      const reply = this.onServerRequest ? this.onServerRequest(msg.method, msg.params, this) : undefined;
      if (reply !== undefined) {
        this.reply(msg.id, reply);
        this.log(`>>REPLIED ${msg.method}`, JSON.stringify(reply).slice(0, 200));
      } else {
        this.log(`>>NO-REPLY (挂起) ${msg.method}`);
      }
      return;
    }
    // 3) notification
    if (typeof msg.method === "string") {
      const b = brief(msg.method, msg.params);
      const last = this.events[this.events.length - 1];
      if (msg.method === "agentMessageDelta" && last?.method === "agentMessageDelta") {
        last.count += 1;
        last.ms = ms();
        return; // 合并连续 delta
      }
      this.events.push({ ms: ms(), method: msg.method, brief: b, count: 1 });
      if (this.verbose || msg.method !== "agentMessageDelta") {
        this.log(`<< ${msg.method}${b ? ` ${b}` : ""}`);
      }
      this._notifyWaiters(msg.method, msg.params, undefined);
    }
  }

  reply(id, result) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
      this.log(`>> ${method}${params ? ` ${JSON.stringify(params).slice(0, 220)}` : ""}`);
    });
  }

  /** 等待满足条件的事件（notification 或 server request）；超时返回 null */
  waitFor(pred, timeoutMs = 60_000, label = "") {
    return new Promise((resolve) => {
      const w = {
        pred,
        resolve: (v) => {
          clearTimeout(w.timer);
          resolve(v);
        },
      };
      w.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        this.log(`WAIT-TIMEOUT ${label || ""} (${timeoutMs}ms)`);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(w);
      // 已发生的事件也算（避免竞态漏掉）
      const hit = this._scanHistory(pred);
      if (hit) w.resolve(hit);
    });
  }

  _scanHistory(pred) {
    for (const e of this.events) {
      if (pred({ kind: "notification", method: e.method, params: null, brief: e.brief })) return { ...e, kind: "notification" };
    }
    for (const r of this.serverRequests) {
      if (pred({ kind: "serverRequest", method: r.method, params: r.params })) return { ...r, kind: "serverRequest" };
    }
    return null;
  }

  _notifyWaiters(method, params, id) {
    for (const w of [...this.waiters]) {
      let hit = null;
      try {
        if (pred_hit(w.pred, { kind: id !== undefined ? "serverRequest" : "notification", method, params })) hit = { method, params, kind: id !== undefined ? "serverRequest" : "notification" };
      } catch {
        hit = null;
      }
      if (hit) {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        w.resolve(hit);
      }
    }
  }

  /** 事件时间线（紧凑，供结论引用） */
  timeline() {
    return this.events
      .map((e) => `${e.ms}ms ${e.method}${e.count > 1 ? `×${e.count}` : ""}${e.brief ? ` ${e.brief}` : ""}`)
      .join("\n");
  }

  async close(signal = "SIGTERM") {
    if (!this.child || this.exitInfo) return;
    this.child.kill(signal);
    await new Promise((r) => setTimeout(r, 600));
    if (!this.exitInfo) this.child.kill("SIGKILL");
  }
}

function pred_hit(pred, ev) {
  return pred(ev) === true;
}

/** 用户输入（text_elements 必填） */
export const text = (t) => ({ type: "text", text: t, text_elements: [] });

export const sleep = (n) => new Promise((r) => setTimeout(r, n));

export function section(title) {
  console.log(`\n================= ${title} =================`);
}
