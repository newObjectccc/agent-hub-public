import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { spawn as Spawn } from "node:child_process";
import { CodexDriverHub, probeCodexCapabilities, type CodexDriverOptions } from "../adapters/codex-driver.js";
import { codexMessageId } from "../adapters/codex-host-protocol.js";
import { UPLOAD_DIR_NAME } from "../uploads.js";
import type { ServerEvent } from "../types.js";

interface Frame { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  frames: Frame[] = [];
  signals: Array<string | undefined> = [];
  killed = false;
  closeOnKill = true;
  nextTurn = 0;
  autoStart = true;
  autoResume = true;
  autoInitialize = true;
  policyEcho: Record<string, unknown> | null = null;
  resumeStatus = "idle";
  resumeError: string | null = null;
  startError: { code: number; message: string } | null = null;
  constructor() {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      const frame: Frame = JSON.parse(String(chunk)); this.frames.push(frame); callback();
      queueMicrotask(() => this.receive(frame));
    } });
  }
  receive(frame: Frame): void {
    if (frame.id === undefined || !frame.method) return;
    if (frame.method === "initialize" && this.autoInitialize) this.respond(frame, { userAgent: "codex/0.162.0-alpha.17.2" });
    if (frame.method === "thread/resume" && this.autoResume) {
      if (this.resumeError) this.stdout.write(`${JSON.stringify({ id: frame.id, error: { code: -32600, message: this.resumeError } })}\n`);
      else this.respond(frame, { ...(this.policyEcho ? { approvalPolicy: frame.params?.approvalPolicy ?? this.policyEcho.approvalPolicy, sandbox: frame.params?.sandbox ? { type: frame.params.sandbox, networkAccess: false, writableRoots: [] } : this.policyEcho.sandbox } : {}), thread: { id: frame.params?.threadId, status: { type: this.resumeStatus } } });
    }
    if (frame.method === "turn/start" && this.autoStart) {
      if (this.startError) this.stdout.write(`${JSON.stringify({ id: frame.id, error: this.startError })}\n`);
      else this.respond(frame, { turn: { id: `turn-${++this.nextTurn}`, status: "inProgress" } });
    }
    if (frame.method === "turn/steer") this.respond(frame, { turnId: frame.params?.expectedTurnId });
    if (frame.method === "turn/interrupt") this.respond(frame, {});
  }
  respond(frame: Frame, result: unknown): void { this.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`); }
  notify(method: string, params: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify({ method, params })}\n`); }
  request(id: number | string, method: string, params: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify({ id, method, params })}\n`); }
  done(status = "completed", turnId = `turn-${this.nextTurn}`): void { this.notify("turn/completed", { threadId: "s1", turn: { id: turnId, status, error: status === "failed" ? { message: "model failed" } : null } }); }
  kill(signal?: string): boolean { this.killed = true; this.signals.push(signal); if (this.closeOnKill) this.emit("close", 0); return true; }
  method(method: string): Frame[] { return this.frames.filter((frame) => frame.method === method); }
}

const opts = { cwd: "/work", sessionFile: "/fake/rollout.jsonl" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, overrides: Partial<CodexDriverOptions> = {}, configure?: (child: FakeChild) => void) {
  const events: ServerEvent[] = [];
  const children: FakeChild[] = [];
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = ((bin: string, args: string[]) => {
    calls.push({ bin, args }); const child = new FakeChild();
    if (overrides.approvalPolicy || overrides.sandbox) child.policyEcho = { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } };
    configure?.(child); children.push(child); return child;
  }) as unknown as typeof Spawn;
  const hub = new CodexDriverHub({
    emit: (_id, event) => events.push(event), spawnFn,
    statFn: async () => ({ mtimeMs: Date.now() - 10_000 }),
    probeCapabilities: async () => ({ version: "0.162.0-alpha.17.2", appServer: true, writerLock: true }),
    hostRequestTtlMs: 100, idleDetachMs: 0, requestTimeoutMs: 100, readyTimeoutMs: 500,
    ...overrides,
  });
  t.after(() => hub.disposeAll());
  const acks = (id: string) => events.filter((event): event is Extract<ServerEvent, { type: "command_ack" }> => event.type === "command_ack" && event.commandId === id);
  const errors = () => events.filter((event): event is Extract<ServerEvent, { type: "error" }> => event.type === "error");
  const settled = () => events.filter((event) => event.type === "agent_settled");
  const child = () => children.at(-1)!;
  return { hub, events, children, calls, acks, errors, settled, child };
}
function approval(child: FakeChild, id: number, method = "item/commandExecution/requestApproval", extra: Record<string, unknown> = {}) {
  child.request(id, method, { threadId: "s1", turnId: `turn-${child.nextTurn}`, itemId: `item-${id}`, command: "ls", ...extra });
}

describe("Codex attach preparation and writer ownership", () => {
  it("shares concurrent attach, waits for resume readiness, and never emits running at initialization", async (t) => {
    const f = fixture(t, {}, (child) => { child.autoResume = false; });
    const a = f.hub.attach("s1", opts);
    const b = f.hub.attach("s1", opts);
    assert.equal(a, b);
    assert.equal(f.hub.isAttaching("s1"), true);
    assert.equal(f.hub.isAttached("s1"), false);
    await tick();
    assert.equal(f.children.length, 1);
    assert.equal(f.hub.isAttached("s1"), false);
    f.child().notify("thread/started", { thread: { id: "s1", status: { type: "idle" } } });
    f.child().respond(f.child().method("thread/resume")[0], { thread: { id: "s1", status: { type: "idle" } } });
    await a;
    assert.equal(f.hub.isAttached("s1"), true);
    assert.equal(f.hub.isAttaching("s1"), false);
    assert.equal(f.hub.runStatusFor("s1"), "idle");
    assert.equal(f.events.some((event) => event.type === "status" && event.status === "running"), false);
    assert.deepEqual(f.calls[0].args, ["app-server"]);
    const params = f.child().method("thread/resume")[0].params!;
    assert.equal(params.excludeTurns, true);
    assert.equal(Object.hasOwn(params, "sandbox"), false);
    assert.equal(Object.hasOwn(params, "approvalPolicy"), false);
    assert.equal(f.hub.statusFor("s1").source, "codex");
  });

  it("preparation reserves capacity and cancellation cannot spawn a late app-server", async (t) => {
    const env = deferred<NodeJS.ProcessEnv>();
    const f = fixture(t, { maxConcurrent: 1, prepareEnv: () => env.promise });
    const first = f.hub.attach("s1", opts);
    const rejected = assert.rejects(first, /取消/);
    await assert.rejects(f.hub.attach("s2", opts), (error: unknown) => (error as { code: string }).code === "DRIVER_LIMIT");
    assert.equal(f.hub.detach("s1"), true);
    await rejected;
    env.resolve({});
    await tick();
    assert.equal(f.children.length, 0);
    assert.equal(f.hub.isAttaching("s1"), false);
  });

  it("bounds preparation timeouts and dispose cancels every preparation", async (t) => {
    const env = deferred<NodeJS.ProcessEnv>();
    const f = fixture(t, { readyTimeoutMs: 15, prepareEnv: () => env.promise });
    await assert.rejects(f.hub.attach("s1", opts), /超时/);
    env.resolve({});
    await tick();
    assert.equal(f.children.length, 0);
    const g = fixture(t, { prepareEnv: () => new Promise(() => undefined) });
    const pending = g.hub.attach("s1", opts);
    const rejected = assert.rejects(pending, /关闭|取消/);
    g.hub.disposeAll();
    await rejected;
    assert.equal(g.children.length, 0);
  });

  it("abort cancels preparation before spawn and also closes an unready app-server", async (t) => {
    const env = deferred<NodeJS.ProcessEnv>();
    const f = fixture(t, { prepareEnv: () => env.promise });
    const pending = f.hub.attach("s1", opts);
    const rejected = assert.rejects(pending, /中止/);
    f.hub.abortTurn("s1");
    await rejected;
    env.resolve({});
    await tick();
    assert.equal(f.children.length, 0);
    assert.equal(f.hub.isBusy("s1"), false);
    const g = fixture(t, {}, (child) => { child.autoInitialize = false; });
    const preparing = g.hub.attach("s1", opts);
    const rejectedSpawn = assert.rejects(preparing, /中止/);
    await tick();
    g.hub.abortTurn("s1");
    await rejectedSpawn;
    assert.equal(g.child().killed, true);
    assert.equal(g.hub.isAttached("s1"), false);
  });

  it("checks quietness again after async preparation and fails closed on missing files", async (t) => {
    let reads = 0;
    const f = fixture(t, { statFn: async () => ({ mtimeMs: ++reads === 1 ? Date.now() - 10_000 : Date.now() }) });
    await assert.rejects(f.hub.attach("s1", opts), /正在写入/);
    assert.equal(f.children.length, 0);
    const g = fixture(t, { statFn: async () => { throw new Error("ENOENT"); } });
    await assert.rejects(g.hub.attach("s1", opts), /会话文件/);
    assert.equal(g.children.length, 0);
  });

  it("rechecks parallel exec/preparation before spawn and after resume", async (t) => {
    let busy = true;
    const f = fixture(t, { parallelBusy: () => busy });
    await assert.rejects(f.hub.attach("s1", opts), (error: unknown) => (error as { code: string }).code === "EXTERNAL_ACTIVE");
    assert.equal(f.children.length, 0);
    busy = false;
    const g = fixture(t, { parallelBusy: () => busy, prepareEnv: async () => { busy = true; return {}; } });
    await assert.rejects(g.hub.attach("s1", opts), /并行/);
    assert.equal(g.children.length, 0);
    busy = false;
    const h = fixture(t, { parallelBusy: () => busy }, (child) => { child.autoResume = false; });
    const pending = h.hub.attach("s1", opts);
    const rejected = assert.rejects(pending, /并行/);
    await tick();
    busy = true;
    h.child().respond(h.child().method("thread/resume")[0], { thread: { id: "s1", status: { type: "idle" } } });
    await rejected;
    assert.equal(h.child().killed, true);
    assert.equal(h.hub.isAttached("s1"), false);
  });

  it("does not start app-server when its writer capabilities are unavailable", async (t) => {
    const f = fixture(t, { probeCapabilities: async () => ({ version: "0.143.0", appServer: true, writerLock: false }) });
    await assert.rejects(f.hub.attach("s1", opts), /能力检查/);
    assert.equal(f.children.length, 0);
    assert.equal(f.hub.statusFor("s1").online, false);
  });

  it("keeps statusFor().online per session instead of globalizing a verified runtime", async (t) => {
    const f = fixture(t, { maxConcurrent: 2 });
    await f.hub.attach("s1", opts);
    assert.equal(f.hub.statusFor("s1").online, true);
    assert.equal(f.hub.statusFor("s1").attached, true);
    // 一个会话接管成功不得让未接管的会话也显示在线（旧行为：capabilityVerified 是进程级单次标志）。
    assert.equal(f.hub.statusFor("s2").online, false);
    assert.equal(f.hub.statusFor("s2").attached, false);
    f.hub.detach("s1");
    await tick();
    assert.equal(f.hub.statusFor("s1").attached, false);
    // 已验证过可接管的会话退出后仍标 online（随时可重新接管），但不外溢到其它会话。
    assert.equal(f.hub.statusFor("s1").online, true);
    assert.equal(f.hub.statusFor("s2").online, false);
  });

  for (const failure of ["already has an active writer", "notLoaded", "active", "systemError"] as const) {
    it(`releases the writer on resume failure: ${failure}`, async (t) => {
      const f = fixture(t, {}, (child) => {
        if (failure === "already has an active writer") child.resumeError = failure;
        else child.resumeStatus = failure;
      });
      await assert.rejects(f.hub.attach("s1", opts), (error: unknown) => {
        const err = error as { code: string; statusCode: number };
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, failure === "active" || failure.includes("writer") ? "SESSION_BUSY" : "ATTACH_UNAVAILABLE");
        return true;
      });
      assert.deepEqual(f.child().signals, ["SIGTERM"]);
      assert.equal(f.hub.isAttached("s1"), false);
      assert.equal(f.events.at(-1)?.type, "attach_state");
    });
  }

  it("times out initialization and keeps closing processes counted until exit", async (t) => {
    const f = fixture(t, { requestTimeoutMs: 10 }, (child) => { child.autoInitialize = false; });
    await assert.rejects(f.hub.attach("s1", opts), /timed out/);
    assert.equal(f.child().killed, true);
    const g = fixture(t, { maxConcurrent: 1 }, (child) => { child.closeOnKill = false; });
    await g.hub.attach("s1", opts);
    g.hub.detach("s1");
    assert.equal(g.hub.isAttached("s1"), false);
    assert.equal(g.hub.isAttaching("s1"), false);
    assert.equal(g.hub.isReleasing("s1"), true);
    assert.equal(g.hub.isBusy("s1"), true);
    await assert.rejects(g.hub.attach("s1", opts), /释放/);
    await assert.rejects(g.hub.attach("s2", opts), /上限/);
    g.child().emit("close", 0);
    assert.equal(g.hub.isBusy("s1"), false);
    await g.hub.attach("s2", opts);
    assert.equal(g.children.length, 2);
  });

  it("sends explicit configured policies only in resume", async (t) => {
    const f = fixture(t, { approvalPolicy: "untrusted", sandbox: "read-only" });
    await f.hub.attach("s1", opts);
    assert.equal(f.children.length, 2);
    assert.deepEqual(f.children[0].method("thread/resume")[0].params, { threadId: "s1", excludeTurns: true, cwd: "/work" });
    assert.deepEqual(f.child().method("thread/resume")[0].params, { threadId: "s1", excludeTurns: true, cwd: "/work", approvalPolicy: "untrusted", sandbox: "read-only" });
    assert.equal(f.hub.statusFor("s1").effectivePolicy?.approval, "untrusted");
  });

  it("version probe invokes only --version and is cancellable", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    let args: unknown;
    const context = { codexBin: "chosen-codex", cwd: "/w", env: {}, signal: controller.signal, spawnFn: ((_bin: string, a: unknown) => { args = a; return child; }) as unknown as typeof Spawn };
    const pending = probeCodexCapabilities(context);
    child.stdout.write("codex-cli 0.162.0-alpha.17.2\n");
    child.emit("close", 0);
    assert.deepEqual(await pending, { version: "0.162.0-alpha.17.2", appServer: true, writerLock: true });
    assert.deepEqual(args, ["--version"]);
    const another = new FakeChild();
    const abort = new AbortController();
    const cancelled = probeCodexCapabilities({ ...context, signal: abort.signal, spawnFn: (() => another) as unknown as typeof Spawn });
    const rejected = assert.rejects(cancelled, /cancel/);
    abort.abort(new Error("cancel"));
    await rejected;
    assert.deepEqual(another.signals, ["SIGKILL"]);
  });
});

describe("Codex commands and native streaming", () => {
  it("acks only after RPC acceptance and reserves a busy turn before the reply", async (t) => {
    const f = fixture(t, {}, (child) => { child.autoStart = false; });
    await f.hub.attach("s1", opts);
    const first = f.hub.send("s1", { text: "one", clientMessageId: "c1" });
    const second = f.hub.send("s1", { text: "two" });
    assert.equal(f.acks(first.id).length, 0);
    assert.equal(f.acks(second.id)[0].ok, false);
    await tick();
    assert.equal(f.child().method("turn/start").length, 1);
    f.child().respond(f.child().method("turn/start")[0], { turn: { id: "t", status: "inProgress" } });
    await tick();
    assert.equal(f.acks(first.id)[0].ok, true);
    assert.equal(f.hub.send("s1", { text: "one", clientMessageId: "c1" }).id, first.id);
    assert.equal(f.child().method("turn/start").length, 1);
  });

  it("exposes bounded read-only command receipts across ack and reconnect without executing again", async (t) => {
    const f = fixture(t, {}, (child) => { child.autoStart = false; });
    await f.hub.attach("s1", opts);
    const first = f.hub.send("s1", { text: "begin", clientMessageId: "receipt" });
    assert.deepEqual(f.hub.commandStatusFor("s1", first.id), { state: "pending", error: null });
    assert.equal(f.hub.commandStatusFor("different", first.id), null);
    const busy = f.hub.send("s1", { text: "busy" });
    assert.equal(f.hub.commandStatusFor("s1", busy.id)?.state, "failed");
    assert.match(f.hub.commandStatusFor("s1", busy.id)?.error ?? "", /正忙/);
    const queued = f.hub.send("s1", { text: "queue", mode: "followUp" });
    assert.equal(f.hub.commandStatusFor("s1", queued.id)?.state, "pending");
    await tick();
    f.child().respond(f.child().method("turn/start")[0], { turn: { id: "t", status: "inProgress" } });
    await tick();
    const snapshot = f.hub.commandStatusFor("s1", first.id)!;
    assert.deepEqual(snapshot, { state: "accepted", error: null });
    snapshot.state = "failed";
    assert.equal(f.hub.commandStatusFor("s1", first.id)?.state, "accepted");
    assert.equal(f.hub.send("s1", { text: "begin", clientMessageId: "receipt" }).id, first.id);
    assert.equal(f.child().method("turn/start").length, 1);
    f.hub.detach("s1");
    assert.equal(f.hub.commandStatusFor("s1", first.id)?.state, "accepted");
    assert.equal(f.hub.commandStatusFor("s1", queued.id)?.state, "failed");
    assert.equal(f.hub.commandStatusFor("s1", first.id, Date.now() + 11 * 60_000), null);
    f.hub.disposeAll();
    assert.equal(f.hub.commandStatusFor("s1", queued.id), null);
  });

  it("uses turn/steer with the expected active ID, including steering while start is pending", async (t) => {
    // P2-6：localImage 只接受会话上传目录内的真实文件，附件路径需走真实上传根
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-driver-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const uploads = join(dir, UPLOAD_DIR_NAME);
    mkdirSync(uploads, { recursive: true });
    const image = join(uploads, "a.png");
    writeFileSync(image, "png");
    const f = fixture(t);
    await f.hub.attach("s1", { cwd: dir, sessionFile: "/fake/rollout.jsonl" });
    f.hub.send("s1", { text: "begin" });
    const steer = f.hub.send("s1", { text: "change direction", mode: "steer", images: [image] });
    await tick();
    assert.equal(f.child().method("turn/start").length, 1);
    assert.deepEqual(f.child().method("turn/steer")[0].params, {
      threadId: "s1", expectedTurnId: "turn-1", input: [{ type: "text", text: "change direction", text_elements: [] }, { type: "localImage", path: resolve(image) }],
    });
    assert.equal(f.acks(steer.id)[0].ok, true);
    assert.equal(f.hub.runStatusFor("s1"), "running");
  });

  it("retries a definitely unsent busy prompt with the same client ID after idle", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    const busy = f.hub.send("s1", { text: "retry-me", clientMessageId: "busy-key" });
    assert.equal(f.acks(busy.id)[0].ok, false);
    await tick();
    f.child().done();
    const retried = f.hub.send("s1", { text: "retry-me", clientMessageId: "busy-key" });
    assert.notEqual(retried.id, busy.id);
    assert.equal(f.acks(busy.id).length, 1);
    await tick();
    assert.equal(f.acks(retried.id)[0].ok, true);
    assert.equal(f.child().method("turn/start").length, 2);
  });

  it("lost turn/start replies replay the unknown-result failure without executing twice", async (t) => {
    const f = fixture(t, { requestTimeoutMs: 10 }, (child) => { child.autoStart = false; });
    await f.hub.attach("s1", opts);
    const first = f.hub.send("s1", { text: "might already be running", clientMessageId: "lost-reply" });
    await delay(20);
    assert.equal(f.acks(first.id)[0].ok, false);
    assert.match(f.acks(first.id)[0].error!, /核对/);
    assert.equal(f.hub.isAttached("s1"), false);
    await f.hub.attach("s1", opts);
    const again = f.hub.send("s1", { text: "might already be running", clientMessageId: "lost-reply" });
    assert.equal(again.id, first.id);
    assert.equal(f.acks(first.id).length, 2);
    assert.equal(f.acks(first.id)[1].ok, false);
    assert.match(f.acks(first.id)[1].error!, /核对/);
    assert.equal(f.children.reduce((count, child) => count + child.method("turn/start").length, 0), 1);
  });

  it("consumes one followUp after turn completion, never after message completion", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    const queued = f.hub.send("s1", { text: "next", mode: "followUp", clientMessageId: "q" });
    f.hub.send("s1", { text: "next", mode: "followUp", clientMessageId: "q" });
    await tick();
    f.child().notify("item/completed", { threadId: "s1", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "partial response" } });
    await tick();
    assert.equal(f.child().method("turn/start").length, 1);
    assert.equal(f.acks(queued.id).length, 0);
    f.child().done();
    await tick();
    assert.equal(f.child().method("turn/start").length, 2);
    assert.equal(f.acks(queued.id).length, 1);
    const settled = f.events.findIndex((event) => event.type === "agent_settled");
    assert.equal(f.events[settled - 1].type === "status" && (f.events[settled - 1] as { status: string }).status, "idle");
    assert.equal(f.events.slice(settled + 1).some((event) => event.type === "status" && event.status === "running"), true);
    f.child().done("completed", "turn-1");
    await tick();
    assert.equal(f.child().method("turn/start").length, 2);
  });

  it("scopes early, live, and late events to the current thread/turn with stable item IDs", async (t) => {
    const f = fixture(t, {}, (child) => { child.autoStart = false; });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin", images: [{ path: "/work/a.png", mimeType: "image/png", data: "YWJj" }] });
    await tick();
    const delta = (threadId: string, turnId: string, text: string) => f.child().notify("item/agentMessage/delta", { threadId, turnId, itemId: "m", delta: text });
    delta("other", "t", "wrong-thread");
    delta("s1", "old", "wrong-turn");
    delta("s1", "t", "你好");
    f.child().respond(f.child().method("turn/start")[0], { turn: { id: "t", status: "inProgress" } });
    await tick();
    assert.deepEqual(f.events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["你好"]);
    const snapshot = f.hub.snapshotFor("s1");
    assert.equal(snapshot[0].role, "user");
    assert.equal(snapshot[0].images?.[0].url, "data:image/png;base64,YWJj");
    assert.equal(snapshot.every((message) => message.turnId === "t"), true);
    assert.equal(snapshot[1].id, codexMessageId("s1", "m"));
    assert.equal(snapshot[1].streaming, true);
    snapshot[1].text = "mutated";
    assert.equal(f.hub.snapshotFor("s1")[1].text, "你好");
    f.child().notify("item/completed", { threadId: "s1", turnId: "t", item: { type: "agentMessage", id: "m", text: "你好世界" } });
    f.child().done("completed", "t");
    delta("s1", "t", "late");
    assert.equal(f.hub.snapshotFor("s1")[1].text, "你好世界");
    assert.equal(f.hub.snapshotFor("s1")[1].streaming, false);
    assert.equal(f.hub.runStatusFor("s1"), "idle");
    f.hub.detach("s1");
    assert.deepEqual(f.hub.snapshotFor("s1"), []);
  });

  it("maps tools and retrying errors without premature settlement", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().notify("item/started", { threadId: "s1", turnId: "turn-1", item: { type: "commandExecution", id: "tool", command: "ls" } });
    f.child().notify("item/completed", { threadId: "s1", turnId: "turn-1", item: { type: "commandExecution", id: "tool", command: "ls", exitCode: 2, aggregatedOutput: "bad" } });
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "temporary" }, willRetry: true });
    assert.equal(f.hub.runStatusFor("s1"), "running");
    assert.equal(f.events.some((event) => event.type === "agent_settled"), false);
    // 可重试错误不是终态：不得当作失败推给手机（旧行为会在此产生一条假报错）。
    assert.equal(f.errors().length, 0);
    assert.equal(f.events.filter((event) => event.type === "tool_start").length, 1);
    assert.equal(f.events.some((event) => event.type === "tool_end" && event.toolCall.status === "error"), true);
    f.child().done("failed");
    assert.equal(f.hub.runStatusFor("s1"), "error");
    assert.equal(f.settled().length, 1);
    // 终态错误有且只有一条，内容是 turn/completed 携带的真实原因，而不是重连提示。
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].message, "model failed");
  });

  it("keeps retryable errors off the phone and surfaces the real failure reason once", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    // 真机复现的形状：任务成功/失败前先来几条 willRetry:true 的重连错误。
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "Reconnecting... 1/5" }, willRetry: true });
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "Reconnecting... 2/5" }, willRetry: true });
    assert.equal(f.errors().length, 0);
    assert.equal(f.hub.runStatusFor("s1"), "running");
    f.child().notify("turn/completed", { threadId: "s1", turn: { id: "turn-1", status: "failed", error: { message: "model refused the request" } } });
    await tick();
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].code, "PROMPT_FAILED");
    assert.equal(f.errors()[0].message, "model refused the request");
    assert.equal(f.settled().length, 1);
    assert.equal(f.hub.runStatusFor("s1"), "error");
  });

  it("emits no error when a retryable error is followed by a successful turn", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "Reconnecting... 2/5" }, willRetry: true });
    f.child().done("completed");
    await tick();
    assert.equal(f.errors().length, 0);
    assert.equal(f.settled().length, 1);
    assert.equal(f.hub.runStatusFor("s1"), "idle");
  });

  it("falls back to the last retryable text only when the terminal notice carries no reason", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "Reconnecting... 3/5" }, willRetry: true });
    f.child().notify("turn/completed", { threadId: "s1", turn: { id: "turn-1", status: "failed", error: null } });
    await tick();
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].message, "Reconnecting... 3/5");
  });

  it("reports a non-retryable error immediately and never duplicates it at completion", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().notify("error", { threadId: "s1", turnId: "turn-1", error: { message: "fatal boom" } });
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].message, "fatal boom");
    f.child().done("failed");
    await tick();
    assert.equal(f.errors().length, 1);
    assert.equal(f.settled().length, 1);
    assert.equal(f.hub.runStatusFor("s1"), "error");
  });

  it("fails a turn that never receives a terminal notification and frees the session", async (t) => {
    const f = fixture(t, { turnWatchdogMs: 20 });
    await f.hub.attach("s1", opts);
    const first = f.hub.send("s1", { text: "begin" });
    await tick();
    assert.equal(f.hub.runStatusFor("s1"), "running");
    await delay(60);
    // 丢一条 turn/completed 不再等于永久 running：watchdog 走既有失败收尾路径。
    assert.equal(f.hub.isAttached("s1"), false);
    assert.notEqual(f.hub.runStatusFor("s1"), "running");
    assert.equal(f.settled().length, 1);
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].code, "DRIVER_FAILED");
    assert.equal(f.events.at(-1)?.type, "attach_state");
    assert.equal(f.child().killed, true);
    assert.equal(f.acks(first.id).length, 1);
    // 后续 prompt 不再被「会话正忙」卡死；重新接管即可继续发消息。
    assert.throws(() => f.hub.send("s1", { text: "again" }), /尚未完成接管/);
    assert.equal(f.events.some((event) => event.type === "command_ack" && event.ok === false && /正忙/.test(event.error ?? "")), false);
    await f.hub.attach("s1", opts);
    const retry = f.hub.send("s1", { text: "again" });
    await tick();
    assert.equal(f.children.length, 2);
    assert.equal(f.acks(retry.id)[0].ok, true);
  });

  it("watchdog waits for live activity instead of killing a streaming turn", async (t) => {
    const f = fixture(t, { turnWatchdogMs: 60 });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    for (let index = 0; index < 4; index += 1) {
      await delay(25);
      f.child().notify("item/agentMessage/delta", { threadId: "s1", turnId: "turn-1", itemId: "m", delta: "x" });
    }
    assert.equal(f.hub.isAttached("s1"), true);
    assert.equal(f.hub.runStatusFor("s1"), "running");
    await delay(120);
    assert.equal(f.hub.isAttached("s1"), false);
    assert.equal(f.settled().length, 1);
  });

  it("watchdog never kills a turn waiting for a phone approval", async (t) => {
    const f = fixture(t, { turnWatchdogMs: 20, hostRequestTtlMs: 2_000 });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    approval(f.child(), 1);
    const requestId = f.hub.listHostRequests("s1")[0].id;
    await delay(80);
    // 手机还没点允许时 thread 可能长时间静止甚至报 idle，不能当成停滞误杀。
    assert.equal(f.hub.isAttached("s1"), true);
    assert.equal(f.hub.runStatusFor("s1"), "running");
    assert.equal(f.hub.listHostRequests("s1").length, 1);
    assert.equal(f.errors().length, 0);
    assert.equal(f.hub.respondHostRequest("s1", requestId, { outcome: "allow" }), true);
    await tick();
    f.child().done();
    await tick();
    assert.equal(f.hub.runStatusFor("s1"), "idle");
    assert.equal(f.errors().length, 0);
    assert.equal(f.settled().length, 1);
  });

  it("surfaces writer contention as a typed error when turn/start is rejected with -32600", async (t) => {
    const f = fixture(t, {}, (child) => { child.startError = { code: -32600, message: "thread already has an active writer" }; });
    await f.hub.attach("s1", opts);
    const command = f.hub.send("s1", { text: "begin" });
    await tick();
    const ack = f.acks(command.id)[0];
    assert.equal(ack.ok, false);
    assert.match(ack.error!, /其他客户端占用/);
    assert.equal(f.errors().length, 1);
    assert.equal(f.errors()[0].code, "SESSION_BUSY");
    assert.match(f.errors()[0].message, /其他客户端占用/);
    assert.equal(f.hub.runStatusFor("s1"), "error");
    assert.equal(f.events.some((event) => event.type === "agent_settled"), true);
  });

  it("maps -32600 to writer contention even when the wording changes", async (t) => {
    const f = fixture(t, {}, (child) => { child.resumeError = "thread is locked by another client"; });
    await assert.rejects(f.hub.attach("s1", opts), (error: unknown) => {
      const err = error as { code: string; statusCode: number };
      assert.equal(err.code, "SESSION_BUSY");
      assert.equal(err.statusCode, 409);
      return true;
    });
    assert.equal(f.hub.isBusy("s1"), false);
  });

  it("interrupts without killing app-server, clears queues, and suppresses aborted late output", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    const queued = f.hub.send("s1", { text: "next", mode: "followUp", clientMessageId: "aborted-queue" });
    approval(f.child(), 9);
    const hostId = f.hub.listHostRequests("s1")[0].id;
    f.hub.abortTurn("s1");
    await tick();
    assert.deepEqual(f.child().method("turn/interrupt")[0].params, { threadId: "s1", turnId: "turn-1" });
    assert.equal(f.child().killed, false);
    assert.equal(f.hub.runStatusFor("s1"), "running");
    assert.equal(f.acks(queued.id)[0].ok, false);
    assert.equal(f.hub.listHostRequests("s1").length, 0);
    assert.equal(f.hub.respondHostRequest("s1", hostId, { outcome: "allow" }), false);
    f.child().notify("item/agentMessage/delta", { threadId: "s1", turnId: "turn-1", itemId: "late", delta: "late" });
    f.child().done("interrupted");
    assert.equal(f.events.some((event) => event.type === "text_delta" && event.delta === "late"), false);
    assert.equal(f.hub.runStatusFor("s1"), "idle");
    assert.equal(f.child().method("turn/start").length, 1);
    assert.equal(f.hub.isAttached("s1"), true);
    const retry = f.hub.send("s1", { text: "next", mode: "followUp", clientMessageId: "aborted-queue" });
    await tick();
    assert.notEqual(retry.id, queued.id);
    assert.equal(f.acks(retry.id)[0].ok, true);
  });

  it("aborts during turn/start and interrupts the eventual turn without showing buffered text", async (t) => {
    const f = fixture(t, {}, (child) => { child.autoStart = false; });
    await f.hub.attach("s1", opts);
    const command = f.hub.send("s1", { text: "begin" });
    await tick();
    f.hub.abortTurn("s1");
    f.child().notify("item/agentMessage/delta", { threadId: "s1", turnId: "t", itemId: "m", delta: "late" });
    f.child().respond(f.child().method("turn/start")[0], { turn: { id: "t", status: "inProgress" } });
    await tick();
    assert.equal(f.acks(command.id).length, 1);
    assert.equal(f.acks(command.id)[0].ok, false);
    assert.equal(f.child().method("turn/interrupt")[0].params?.turnId, "t");
    assert.equal(f.events.some((event) => event.type === "text_delta"), false);
    f.child().done("interrupted", "t");
  });

  it("crash closes attach, denies approvals and fails all queued commands", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    const queued = f.hub.send("s1", { text: "next", mode: "followUp" });
    approval(f.child(), 1);
    const requestId = f.hub.listHostRequests("s1")[0].id;
    f.child().emit("error", new Error("sensitive raw diagnostic"));
    assert.equal(f.hub.isAttached("s1"), false);
    assert.equal(f.hub.listHostRequests("s1").length, 0);
    assert.equal(f.hub.isResolvedHostRequest(requestId), true);
    assert.equal(f.acks(queued.id)[0].ok, false);
    assert.equal(f.events.some((event) => event.type === "error" && event.message.includes("sensitive raw")), false);
    assert.equal(f.events.at(-1)?.type, "attach_state");
    f.child().stdin.emit("error", new Error("late EPIPE"));
  });

  it("idle-detaches only when no turn is active", async (t) => {
    const f = fixture(t, { idleDetachMs: 15 });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await delay(25);
    assert.equal(f.hub.isAttached("s1"), true);
    f.child().done();
    await delay(25);
    assert.equal(f.hub.isAttached("s1"), false);
    assert.equal(f.child().killed, true);
  });

  it("drops the entry when the child reports error or exit without close", async (t) => {
    // spawn 失败、kill 抛错等场景可能只发 error/exit 不发 close；只依赖 close 时条目永驻，
    // 该会话永久 isReleasing/isBusy 并长期占掉一个并发名额。
    const f = fixture(t, {}, (child) => { child.closeOnKill = false; });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().emit("error", new Error("spawn failed"));
    assert.equal(f.hub.isBusy("s1"), false);
    assert.equal(f.hub.isAttached("s1"), false);
    assert.equal(f.settled().length, 1);
    assert.equal(f.errors().length, 1);
    assert.equal(f.events.at(-1)?.type, "attach_state");

    const g = fixture(t, { maxConcurrent: 1 }, (child) => { child.closeOnKill = false; });
    await g.hub.attach("s2", opts);
    g.hub.detach("s2");
    assert.equal(g.hub.isReleasing("s2"), true);
    assert.equal(g.hub.isBusy("s2"), true);
    g.child().emit("exit", 0);
    assert.equal(g.hub.isReleasing("s2"), false);
    assert.equal(g.hub.isBusy("s2"), false);
    // 名额已释放：另一个会话可以接管。
    await g.hub.attach("s3", opts);
    assert.equal(g.children.length, 2);
  });
});

describe("Codex native ServerRequests", () => {
  it("shows allowlisted file paths, change kinds and bounded diffs in approval cards", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "edit files" });
    await tick();
    f.child().notify("item/started", { threadId: "s1", turnId: "turn-1", item: {
      type: "fileChange", id: "files", status: "inProgress", privateToken: "must-not-forward",
      changes: [
        { path: "/work/a.ts", kind: { type: "update", move_path: "/work/b.ts" }, diff: "@@ -1 +1 @@\n-old\n+new", extra: "do-not-forward" },
        { path: "/work/new.ts", kind: { type: "add" }, diff: `+${"内容".repeat(8_000)}` },
      ],
    } });
    approval(f.child(), 1, "item/fileChange/requestApproval", { itemId: "files", reason: "needs write access" });
    const detail = f.hub.listHostRequests("s1")[0].detail!;
    assert.match(detail, /\/work\/a.ts（修改）/);
    assert.match(detail, /移动至：\/work\/b.ts/);
    assert.match(detail, /-old\n\+new/);
    assert.match(detail, /\/work\/new.ts（新增）/);
    assert.match(detail, /预览已截断/);
    assert.equal(Buffer.byteLength(detail) <= 8 * 1024, true);
    assert.equal(detail.includes("\uFFFD"), false);
    assert.equal(detail.includes("must-not-forward"), false);
    assert.equal(detail.includes("do-not-forward"), false);
  });

  it("uses the matching item command when absent and explicitly labels missing file diffs", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    f.child().notify("item/started", { threadId: "s1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-item", command: "git status --short" } });
    approval(f.child(), 1, undefined, { itemId: "cmd-item", command: undefined });
    approval(f.child(), 2, "item/fileChange/requestApproval", { itemId: "no-diff" });
    let requests = f.hub.listHostRequests("s1");
    assert.match(requests[0].detail!, /git status --short/);
    assert.match(requests[1].detail!, /尚未收到.*diff/);
    f.child().done();
    f.hub.send("s1", { text: "another turn" });
    await tick();
    approval(f.child(), 3, undefined, { itemId: "cmd-item", command: undefined });
    requests = f.hub.listHostRequests("s1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].title.includes("git status"), false);
    assert.equal(requests[0].detail?.includes("git status") ?? false, false);
  });

  it("allows native request IDs to be reused in later turns without reviving old phone approvals", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "first" });
    await tick();
    f.child().request("approval-1", "item/commandExecution/requestApproval", { threadId: "s1", turnId: "turn-1", itemId: "first-tool", command: "first command" });
    const first = f.hub.listHostRequests("s1")[0];
    assert.equal(f.hub.respondHostRequest("s1", first.id, { outcome: "allow" }), true);
    await tick();
    f.child().done();
    f.hub.send("s1", { text: "second" });
    await tick();
    f.child().request("approval-1", "item/commandExecution/requestApproval", { threadId: "s1", turnId: "turn-2", itemId: "second-tool", command: "second command" });
    const second = f.hub.listHostRequests("s1")[0];
    assert.ok(second);
    assert.notEqual(second.id, first.id);
    assert.match(second.detail!, /second command/);
    assert.equal(f.hub.respondHostRequest("s1", first.id, { outcome: "allow" }), false);
    f.child().notify("serverRequest/resolved", { threadId: "s1", requestId: "approval-1", turnId: "turn-1" });
    f.child().notify("serverRequest/resolved", { threadId: "s1", requestId: "approval-1" });
    assert.equal(f.hub.listHostRequests("s1")[0].id, second.id);
    assert.equal(f.hub.respondHostRequest("s1", second.id, { outcome: "deny" }), true);
    await tick();
    assert.deepEqual(f.child().frames.filter((frame) => frame.id === "approval-1").map((frame) => frame.result), [{ decision: "accept" }, { decision: "decline" }]);
  });

  it("supports command, file and permission approvals without persistent or enlarged grants", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    approval(f.child(), 1);
    approval(f.child(), 2, "item/fileChange/requestApproval");
    approval(f.child(), 3, "item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: ["/work/a"] } }, accessToken: "hidden" });
    const requests = f.hub.listHostRequests("s1");
    assert.equal(requests.length, 3);
    assert.equal(JSON.stringify(requests).includes("hidden"), false);
    assert.equal(f.hub.respondHostRequest("s1", requests[0].id, { outcome: "allow" }), true);
    assert.equal(f.hub.respondHostRequest("s1", requests[1].id, { outcome: "deny" }), true);
    assert.equal(f.hub.respondHostRequest("s1", requests[2].id, { outcome: "allow" }), true);
    assert.equal(f.hub.respondHostRequest("s1", requests[0].id, { outcome: "allow" }), false);
    assert.equal(f.hub.isResolvedHostRequest(requests[0].id), true);
    await tick();
    const result = (id: number) => f.child().frames.find((frame) => frame.id === id && frame.result !== undefined)?.result;
    assert.deepEqual(result(1), { decision: "accept" });
    assert.deepEqual(result(2), { decision: "decline" });
    assert.deepEqual(result(3), { permissions: { network: { enabled: true }, fileSystem: { write: ["/work/a"] } }, scope: "turn" });
  });

  it("times out safely and delayed answers never affect the next turn", async (t) => {
    const f = fixture(t, { hostRequestTtlMs: 10 });
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    approval(f.child(), 1);
    const old = f.hub.listHostRequests("s1")[0].id;
    await delay(20);
    assert.equal(f.hub.isResolvedHostRequest(old), true);
    assert.equal(f.hub.listHostRequests("s1").length, 0);
    assert.equal(f.child().frames.some((frame) => frame.id === 1 && (frame.result as { decision?: string })?.decision === "decline"), true);
    f.child().done();
    f.hub.send("s1", { text: "second" });
    await tick();
    approval(f.child(), 2);
    assert.equal(f.hub.respondHostRequest("s1", old, { outcome: "allow" }), false);
    assert.equal(f.hub.listHostRequests("s1").length, 1);
    assert.notEqual(f.hub.listHostRequests("s1")[0].id, old);
  });

  it("serverRequest/resolved removes the card without claiming approval", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    approval(f.child(), 1);
    const request = f.hub.listHostRequests("s1")[0];
    f.child().notify("serverRequest/resolved", { threadId: "s1", requestId: 1 });
    assert.equal(f.hub.listHostRequests("s1").length, 0);
    assert.equal(f.hub.isResolvedHostRequest(request.id), true);
    assert.equal(f.events.some((event) => event.type === "host_request_resolved" && event.outcome === "allow"), false);
  });

  it("rejects questions, declines elicitation and answers every unknown request without exposing tokens", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    for (const [index, method] of ["item/tool/requestUserInput", "mcpServer/elicitation/request", "account/chatgptAuthTokens/refresh", "item/tool/call", "attestation/generate", "unknown/method", "toString"].entries()) {
      f.child().request(index, method, { accessToken: "do-not-send", questions: [{ id: "q", options: [{ label: "Allow" }] }] });
    }
    await tick();
    assert.deepEqual(f.child().frames.find((frame) => frame.id === 1)?.result, { action: "decline", content: null });
    for (const index of [0, 2, 3, 4, 5, 6]) assert.equal(f.child().frames.find((frame) => frame.id === index)?.error?.code, -32601);
    assert.equal(f.events.some((event) => event.type === "host_request"), false);
    assert.equal(JSON.stringify(f.events).includes("do-not-send"), false);
  });

  it("declines stale or foreign approvals without creating phone cards, and detach releases the process", async (t) => {
    const f = fixture(t);
    await f.hub.attach("s1", opts);
    f.hub.send("s1", { text: "begin" });
    await tick();
    approval(f.child(), 1, undefined, { threadId: "foreign" });
    approval(f.child(), 2, undefined, { turnId: "old" });
    approval(f.child(), 3);
    const request = f.hub.listHostRequests("s1")[0];
    assert.equal(f.hub.listHostRequests("s1").length, 1);
    f.hub.detach("s1");
    await tick();
    assert.deepEqual(f.child().signals, ["SIGTERM"]);
    assert.equal(f.hub.isResolvedHostRequest(request.id), true);
    assert.equal(f.hub.respondHostRequest("s1", request.id, { outcome: "allow" }), false);
    assert.equal(f.hub.isAttached("s1"), false);
  });
});

describe("Codex 接管权限基线", () => {
  it("拒绝只读覆盖为工作区可写，且从不发 turn", async t => {
    const f = fixture(t, {sandbox:"workspace-write"}, child => {child.policyEcho={approvalPolicy:"untrusted",sandbox:{type:"readOnly",networkAccess:false}};});
    await assert.rejects(f.hub.attach("s1", opts), /更宽松/);
    assert.equal(f.children.length,1);
    assert.equal(f.child().method("turn/start").length,0);
    assert.equal(f.hub.isAttached("s1"),false);
  });
  it("缺少基线回显时拒绝显式覆盖，inherit 仍兼容旧回显", async t => {
    const f=fixture(t,{approvalPolicy:"untrusted"},child=>{child.policyEcho=null;});
    await assert.rejects(f.hub.attach("s1",opts),/无法确认/);
    assert.equal(f.child().method("turn/start").length,0);
  });
  it("新进程忽略权限覆盖时不标记 attached", async t => {
    let spawned=0;
    const f=fixture(t,{approvalPolicy:"untrusted"},child=>{
      spawned+=1;
      if(spawned===2){const receive=child.receive.bind(child);child.receive=frame=>{
        if(frame.method==="thread/resume"){child.respond(frame,{approvalPolicy:"on-request",sandbox:{type:"workspaceWrite",networkAccess:false},thread:{id:"s1",status:{type:"idle"}}});return;}
        receive(frame);
      };}
    });
    await assert.rejects(f.hub.attach("s1",opts),/未应用/);
    assert.equal(f.hub.isAttached("s1"),false);
  });
});

describe("权限重建期间保持写者互斥",()=>{
  it("未确认旧进程退出时仍 busy，取消后不启动第二个 writer",async t=>{
    const f=fixture(t,{approvalPolicy:"untrusted",readyTimeoutMs:2000},child=>{child.closeOnKill=false;});
    const pending=f.hub.attach("s1",opts);await tick();
    assert.equal(f.hub.isAttaching("s1"),true);assert.equal(f.hub.isBusy("s1"),true);
    assert.equal(f.children.length,1);
    f.hub.detach("s1");
    await assert.rejects(pending,/取消/);
    f.child().emit("close",0);await tick();
    assert.equal(f.children.length,1);assert.equal(f.hub.isBusy("s1"),false);
  });
});

describe("释放写者的异常路径",()=>{
  it("已发送停止但 kill 报错，不能把仍存活的进程当作已释放",async t=>{
    const f=fixture(t);await f.hub.attach("s1",opts);
    Object.assign(f.child(),{pid:12345,exitCode:null,signalCode:null});f.child().closeOnKill=false;
    f.hub.detach("s1");f.child().emit("error",new Error("kill EPERM"));
    assert.equal(f.hub.isBusy("s1"),true);assert.equal(f.hub.isReleasing("s1"),true);
    f.child().emit("close",0);assert.equal(f.hub.isBusy("s1"),false);
  });
});
