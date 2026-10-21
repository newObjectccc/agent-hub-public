import { strict as assert } from "node:assert";
import type { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { CodexAdapter, type CodexAdapterOptions } from "../adapters/codex.js";
import { ErrorCodes, HubError } from "../errors.js";
import type { ServerEvent } from "../types.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string): boolean { this.signals.push(signal); return true; }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: Partial<CodexAdapterOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), "agent-hub-codex-runtime-"));
  const children: FakeChild[] = [];
  const calls: Array<{ bin: string; args: string[] }> = [];
  const events: ServerEvent[] = [];
  const adapter = new CodexAdapter({
    sessionsDir: join(base, "sessions"), sessionIndexFile: join(base, "session_index.jsonl"),
    prepareProviderEnv: async () => {},
    spawnFn: ((bin: string, args: string[]) => {
      // createSession 的 --version 探测（P0：session_meta 必需 cli_version）：立即回应并退出，
      // 不计入 children/calls（本文件断言只针对 prompt 流程子进程）；测试绝不真 spawn codex。
      if (args[0] === "--version") {
        const probe = new FakeChild();
        setImmediate(() => { probe.stdout.end("codex-cli 0.162.0\n"); probe.emit("close", 0); });
        return probe as unknown as ChildProcess;
      }
      const child = new FakeChild(); children.push(child); calls.push({ bin, args });
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    emit: (_id, event) => { events.push(event); },
    ...options,
  });
  const session = await adapter.createSession(base);
  return {
    adapter, session, children, calls, events,
    async cleanup() { adapter.disposeAll(); await rm(base, { recursive: true, force: true }); },
  };
}

it("Codex preparation serializes concurrent prompts and exposes the pending busy boundary", async () => {
  const ready = deferred();
  const entered = deferred();
  let preparing = 0;
  const f = await fixture({ prepareProviderEnv: async () => { preparing += 1; if (preparing === 2) entered.resolve(); await ready.promise; } });
  try {
    const first = f.adapter.prompt(f.session.id, "第一条", undefined);
    const second = f.adapter.prompt(f.session.id, "第二条", undefined);
    await entered.promise;
    assert.equal(f.adapter.isLive(f.session.id), true);
    assert.equal(f.children.length, 0);
    ready.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results.filter((result) => result.accepted).length, 1);
    assert.equal(results.filter((result) => result.busy).length, 1);
    assert.equal(f.children.length, 1);
  } finally { ready.resolve(); await f.cleanup(); }
});

it("Codex abort during preparation cancels every pending attempt without spawning", async () => {
  const ready = deferred(); const entered = deferred();
  const f = await fixture({ prepareProviderEnv: async () => { entered.resolve(); await ready.promise; } });
  try {
    const request = f.adapter.prompt(f.session.id, "cancel me", undefined);
    await entered.promise;
    await f.adapter.abort(f.session.id);
    ready.resolve();
    await assert.rejects(request, (error: unknown) => error instanceof HubError && error.code === ErrorCodes.PROMPT_FAILED);
    assert.equal(f.children.length, 0);
    assert.equal(f.adapter.isLive(f.session.id), false);
  } finally { ready.resolve(); await f.cleanup(); }
});

it("Codex driver preparation/ownership and newer external writes reject unconsumed queues", async () => {
  let driverBusy = true;
  const f = await fixture({ driverBusy: () => driverBusy, driverStatus: () => driverBusy ? "idle" : null });
  try {
    assert.equal((await f.adapter.findSession(f.session.id))?.status, "idle");
    assert.equal((await f.adapter.prompt(f.session.id, "blocked", undefined)).busy, true);
    await assert.rejects(f.adapter.prompt(f.session.id, "queue", "followUp"), (error: unknown) => error instanceof HubError && error.code === ErrorCodes.SESSION_BUSY);
    driverBusy = false;
    // A later write from a terminal must outrank the adapter's remembered create/settled idle.
    const later = new Date(Date.now() + 1_000);
    await utimes(f.session.sessionFile, later, later);
    assert.equal((await f.adapter.prompt(f.session.id, "external busy", undefined)).busy, true);
    await assert.rejects(f.adapter.prompt(f.session.id, "external queue", "steer"), (error: unknown) => error instanceof HubError && error.code === ErrorCodes.SESSION_BUSY);
    assert.equal(f.children.length, 0);
  } finally { await f.cleanup(); }
});

it("Codex UTF-8 split chunks and a terminal row without newline survive process close", async () => {
  const f = await fixture();
  try {
    await f.adapter.prompt(f.session.id, "hello", undefined);
    const child = f.children[0];
    const line = Buffer.from(JSON.stringify({ type: "agent_message_content_delta", delta: "你好世界" }) + "\n");
    const split = line.indexOf(Buffer.from("你")) + 1;
    child.stdout.emit("data", line.subarray(0, split));
    child.stdout.emit("data", line.subarray(split));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "turn.completed" })));
    child.emit("close", 0);
    const assistant = f.events.find((event) => event.type === "message_end" && event.message.role === "assistant");
    assert.equal(assistant?.type === "message_end" ? assistant.message.text : null, "你好世界");
    assert.equal(f.events.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(f.adapter.getStatus(f.session.id), "idle");
  } finally { await f.cleanup(); }
});

it("Codex turn terminal/error events never advance the queue before close; image attachments survive", async () => {
  const f = await fixture({ codexBin: "/test bin/codex" });
  const image = { path: "/uploads/example.png", mimeType: "image/png", data: "aGVsbG8=" };
  try {
    await f.adapter.prompt(f.session.id, "first", undefined, [image]);
    assert.equal(f.calls[0].bin, "/test bin/codex");
    await f.adapter.prompt(f.session.id, "second", "followUp", [image]);
    const first = f.children[0];
    first.stdout.emit("data", JSON.stringify({ type: "turn.completed" }) + "\n");
    assert.equal(f.children.length, 1);
    assert.equal((await f.adapter.prompt(f.session.id, "too soon", undefined)).busy, true);
    first.emit("error", new Error("pipe failed"));
    assert.equal(f.children.length, 1);
    first.emit("close", 0);
    assert.equal(f.children.length, 2);
    const users = f.events.filter((event): event is Extract<ServerEvent, { type: "message_end" }> => event.type === "message_end" && event.message.role === "user");
    assert.equal(users.length, 2);
    assert.equal(users[0].message.images?.[0].url, "data:image/png;base64,aGVsbG8=");
    assert.equal(users[1].message.images?.[0].url, "data:image/png;base64,aGVsbG8=");
    assert.match(users[1].message.text, /second/);
    assert.match(f.calls[1].args.at(-1) ?? "", /example\.png/);
  } finally { await f.cleanup(); }
});

it("Codex abort ignores old stdout and errors, clears queued turns, and remains idempotent", async () => {
  const f = await fixture();
  try {
    await f.adapter.prompt(f.session.id, "first", undefined);
    await f.adapter.prompt(f.session.id, "queued", "followUp");
    const child = f.children[0];
    await f.adapter.abort(f.session.id);
    await f.adapter.abort(f.session.id);
    const count = f.events.length;
    child.stdout.emit("data", JSON.stringify({ type: "agent_message", message: "stale" }) + "\n");
    child.stdout.emit("data", JSON.stringify({ type: "turn.started" }) + "\n");
    child.emit("error", new Error("aborted"));
    child.emit("close", 1);
    assert.equal(f.events.length, count);
    assert.equal(f.children.length, 1);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(f.adapter.getStatus(f.session.id), "idle");
  } finally { await f.cleanup(); }
});

it("Codex closing time covers final rollout writes after the earlier turn terminal", async () => {
  const f = await fixture();
  try {
    await f.adapter.prompt(f.session.id, "first", undefined);
    f.children[0].stdout.emit("data", JSON.stringify({ type: "turn.completed" }) + "\n");
    // Move beyond the terminal event's millisecond so this really is a later write.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = new Date(); await utimes(f.session.sessionFile, now, now);
    f.children[0].emit("close", 0);
    assert.equal((await f.adapter.prompt(f.session.id, "next", undefined)).accepted, true);
    assert.equal(f.children.length, 2);
  } finally { await f.cleanup(); }
});
