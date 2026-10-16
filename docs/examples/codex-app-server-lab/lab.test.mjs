import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer, UNSUPPORTED, safeMetadata } from "./lab.mjs";
import { childEnv, loadShellProviderEnv } from "./env.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const secret = "SECRET_PROTOCOL_BODY_中文_123";

async function serverFor(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "codex-harness-test-"));
  const logs = [];
  const writes = [];
  const env = { ...process.env, CODEX_LAB_LOAD_SHELL_ENV: "0", CODEX_LAB_FAKE_MODE: options.mode ?? "normal", CODEX_LAB_FAKE_TRACE: join(cwd, "trace.jsonl"), FAKE_INJECTED: "yes" };
  const server = new AppServer({
    cwd, env, log: (event, meta) => logs.push({ event, meta }),
    spawn: (_bin, _args, opts) => {
      const child = spawn(process.execPath, [fixture], opts);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...args) => { writes.push(JSON.parse(chunk)); return write(chunk, ...args); };
      return child;
    },
    limits: { requestMs: 5000, handlerMs: 1000, closeMs: 300, ...options.limits },
  }).start();
  t.after(async () => { await server.close(); rmSync(cwd, { recursive: true, force: true }); });
  if (options.initialize !== false) await server.initialize();
  return { server, logs, writes, cwd, trace: () => readFileSync(join(cwd, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse) };
}
async function emit(server, events) {
  await server.request("fake/emit", { events });
  await server.request("fake/state"); // All prior notifications have now crossed stdout.
}
const completed = (threadId, turnId, status = "completed") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
const scope = { threadId: "thread", turnId: "turn", after: 0 };

test("initialize sends initialized and opts into experimental API only on request", async (t) => {
  const { server, trace } = await serverFor(t, { initialize: false });
  await server.initialize();
  const state = await server.request("fake/state");
  assert.equal(state.initialized, true);
  assert.equal(state.initializeParams.capabilities, undefined);
  assert.deepEqual(trace().slice(0, 2).map((message) => message.method), ["initialize", "initialized"]);
});

test("experimental initialize capability is explicit", async (t) => {
  const { server } = await serverFor(t, { initialize: false });
  await server.initialize({ experimentalApi: true });
  assert.deepEqual((await server.request("fake/state")).initializeParams.capabilities, { experimentalApi: true });
});

test("UTF-8 split inside Chinese bytes preserves text", async (t) => {
  const { server } = await serverFor(t);
  const event = server.waitFor((candidate) => candidate.method === "fake/unicode");
  await server.request("fake/utf8");
  assert.equal((await event).params.text, "中文🙂尾");
});

test("stdout end flushes a valid final JSON line without newline", async (t) => {
  const { server } = await serverFor(t);
  assert.deepEqual(await server.request("fake/tail"), { text: "中文尾行" });
  assert.equal(server.pending.size, 0);
});

test("cached event retains params and matching history leaves no waiter", async (t) => {
  const { server } = await serverFor(t);
  await emit(server, [completed("thread", "turn")]);
  const event = await server.waitFor("turn/completed", scope);
  assert.equal(event.params.turn.status, "completed");
  assert.equal(server.waiters.size, 0);
});

test("consumed terminal history cannot settle another wait", async (t) => {
  const { server } = await serverFor(t);
  await emit(server, [completed("thread", "turn")]);
  await server.waitFor("turn/completed", scope);
  await assert.rejects(server.waitFor("turn/completed", { ...scope, timeoutMs: 30 }), { code: "WAIT_TIMEOUT" });
  assert.equal(server.waiters.size, 0);
});

test("default cursor ignores old history and both thread and turn are correlated", async (t) => {
  const { server } = await serverFor(t);
  await emit(server, [completed("thread", "old-turn")]);
  const event = server.waitFor("turn/completed", { threadId: "thread", turnId: "new-turn" });
  await emit(server, [completed("other-thread", "new-turn"), completed("thread", "old-turn"), completed("thread", "new-turn", "interrupted")]);
  assert.equal((await event).params.turn.status, "interrupted");
  assert.equal(server.waiters.size, 0);
});

test("unscoped turn/item waits are rejected", async (t) => {
  const { server } = await serverFor(t);
  await assert.rejects(server.waitFor("turn/completed"), { code: "EVENT_SCOPE_REQUIRED" });
  await assert.rejects(server.waitFor("item/started", { threadId: "thread" }), { code: "EVENT_SCOPE_REQUIRED" });
});

test("real delta name merges by thread/turn/item without body logs", async (t) => {
  const { server, logs } = await serverFor(t);
  const delta = (part, itemId = "agent") => ({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId, delta: part } });
  await emit(server, [delta("中文"), delta("🙂"), delta("secret", "other-agent")]);
  const events = server.events.filter((event) => event.method === "item/agentMessage/delta");
  assert.equal(events.length, 2);
  assert.equal(events[0].params.delta, "中文🙂");
  assert.equal(events[0].count, 2);
  assert(!JSON.stringify(logs).includes("中文"));
  assert(!JSON.stringify(server.timeline()).includes("secret"));
});

test("history count, byte budget and merged delta length stay bounded", async (t) => {
  const { server } = await serverFor(t, { limits: { history: 3, historyBytes: 450, deltaChars: 8 } });
  await emit(server, Array.from({ length: 10 }, (_, i) => ({ method: "fake/event", params: { index: i, text: "x".repeat(50) } })));
  assert(server.history.length <= 3);
  assert(server.historyBytes <= 450);
  assert(server.droppedEvents > 0);
  await emit(server, Array.from({ length: 3 }, () => ({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "agent", delta: "12345" } })));
  assert.equal(server.history.at(-1).params.delta.length, 8);
  assert.equal(server.history.at(-1).truncated, true);
});

test("pending request limit rejects new work without growing the map", async (t) => {
  const { server } = await serverFor(t, { limits: { pending: 1 } });
  const pending = server.request("fake/hang");
  const settled = assert.rejects(pending, { code: "CLIENT_CLOSED" });
  await assert.rejects(server.request("fake/state"), { code: "PENDING_LIMIT" });
  assert.equal(server.pending.size, 1);
  await server.close(); await settled;
  assert.equal(server.pending.size, 0);
});

test("waiter limit rejects new work and close removes all timers", async (t) => {
  const { server } = await serverFor(t, { limits: { waiters: 1 } });
  const waiting = assert.rejects(server.waitFor("fake/never"), { code: "CLIENT_CLOSED" });
  await assert.rejects(server.waitFor("fake/also-never"), { code: "WAITER_LIMIT" });
  await server.close(); await waiting;
  assert.equal(server.waiters.size, 0);
});

test("request timeout rejects all pending requests and waiters", async (t) => {
  const { server } = await serverFor(t);
  const results = await Promise.allSettled([server.request("fake/hang", {}, 30), server.request("fake/hang"), server.waitFor("fake/never")]);
  assert(results.every((result) => result.status === "rejected" && result.reason.code === "REQUEST_TIMEOUT"));
  assert.equal(server.pending.size, 0); assert.equal(server.waiters.size, 0);
});

for (const [method, code] of [["fake/bad-json", "INVALID_PROTOCOL"], ["fake/oversize", "MESSAGE_LIMIT"], ["fake/unexpected-response", "UNEXPECTED_RESPONSE"]]) {
  test(`${method} fails explicitly and clears pending state`, async (t) => {
    const { server } = await serverFor(t, { limits: { messageBytes: 512 } });
    await assert.rejects(server.request(method), { code });
    assert.equal(server.pending.size, 0); assert.equal(server.waiters.size, 0);
    assert.equal(server.buf, "");
  });
}

test("spawn error rejects requests with safe error and closes", async () => {
  const server = new AppServer({ bin: join(tmpdir(), `missing-codex-${process.pid}-${Date.now()}`), log: () => {} }).start();
  try { await assert.rejects(server.initialize(), { code: "SPAWN_ERROR" }); }
  finally { await server.close(); }
  assert.equal(server.pending.size, 0);
});

test("process close rejects requests and waiters and records exit code", async (t) => {
  const { server } = await serverFor(t);
  const results = await Promise.allSettled([server.request("fake/crash"), server.waitFor("fake/never")]);
  assert(results.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_CLOSED"));
  assert.equal(server.exitInfo.code, 7);
  assert.equal(server.pending.size, 0); assert.equal(server.waiters.size, 0);
});

test("async ServerRequest handler is awaited before JSON serialization", async (t) => {
  const { server } = await serverFor(t);
  server.onServerRequest = async () => { await Promise.resolve(); return { decision: "decline" }; };
  const reply = server.waitFor("fake/clientReply");
  await server.request("fake/serverRequest", {});
  assert.deepEqual((await reply).params.result, { decision: "decline" });
  assert.equal(server.handlers.size, 0);
});

test("unknown ServerRequest receives -32601 and fails instead of hanging", async (t) => {
  const { server, writes } = await serverFor(t);
  const failed = assert.rejects(server.waitFor("fake/never"), { code: "UNKNOWN_SERVER_REQUEST" });
  await server.request("fake/serverRequest", { method: "unknown/private-secret" });
  await failed;
  await server.close();
  const reply = writes.find((message) => message.id === 91 && !message.method);
  assert.equal(reply.error.code, -32601);
  assert.equal(server.handlers.size, 0);
});

test("explicit unsupported question does not invent an answer", async (t) => {
  const { server } = await serverFor(t);
  server.onServerRequest = () => UNSUPPORTED;
  const reply = server.waitFor("fake/clientReply");
  await server.request("fake/serverRequest", { method: "item/tool/requestUserInput" });
  const result = (await reply).params;
  assert.equal(result.error.code, -32601);
  assert.equal(result.result, undefined);
  server.assertHealthy();
});

test("handler rejection fails safely and clears pending handlers", async (t) => {
  const { server, writes } = await serverFor(t);
  server.onServerRequest = async () => { throw new Error(secret); };
  const failed = assert.rejects(server.waitFor("fake/never"), { code: "SERVER_HANDLER_ERROR" });
  await server.request("fake/serverRequest", {});
  await failed; await server.close();
  assert.equal(writes.find((message) => message.id === 91 && !message.method).error.code, -32603);
  assert.equal(server.handlers.size, 0);
});

test("handler timeout cancels every outstanding wait and timer", async (t) => {
  const { server } = await serverFor(t, { limits: { handlerMs: 30 } });
  server.onServerRequest = () => new Promise(() => {});
  const failed = assert.rejects(server.waitFor("fake/never"), { code: "SERVER_HANDLER_TIMEOUT" });
  await server.request("fake/serverRequest", {});
  await failed;
  assert.equal(server.handlers.size, 0); assert.equal(server.waiters.size, 0);
});

test("close escalates an uncooperative process and resolves without retained requests", async (t) => {
  const { server } = await serverFor(t, { mode: "ignore-term", limits: { closeMs: 50 } });
  await server.close();
  assert.equal(server.exitInfo.signal, "SIGKILL");
  assert.equal(server.pending.size, 0); assert.equal(server.waiters.size, 0); assert.equal(server.handlers.size, 0);
  await server.close();
});

test("direct Promise replies are rejected before writing JSON", async (t) => {
  const { server, trace } = await serverFor(t);
  await assert.rejects(server.reply("promise-test", Promise.resolve({ decision: "accept" })), { code: "PROMISE_RESPONSE" });
  await server.request("fake/state");
  assert(!trace().some((message) => message.id === "promise-test"));
});

test("predicate errors reject only that waiter and cannot leak a waiter", async (t) => {
  const { server } = await serverFor(t);
  const failed = assert.rejects(server.waitFor(() => { throw new Error(secret); }), { code: "PREDICATE_ERROR" });
  await emit(server, [{ method: "fake/event", params: {} }]); await failed;
  assert.equal(server.waiters.size, 0);
  server.assertHealthy();
});

test("logs, timelines and RPC error objects exclude credentials and protocol bodies", async (t) => {
  const { server, logs } = await serverFor(t);
  await server.request("account/read", { refreshToken: false });
  await server.request("fake/stderr");
  let error;
  try { await server.request("fake/error", { authToken: secret, input: secret }); } catch (value) { error = value; }
  await emit(server, [{ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "agent", type: "agentMessage", text: secret, command: secret }, authToken: secret } }]);
  const output = JSON.stringify({ logs, timeline: server.timeline(), error });
  assert(!output.includes(secret)); assert(!output.includes("authToken"));
  assert(server.stderrBytes > 0);
  assert.equal(error.message, "RPC_ERROR");
  assert.deepEqual(safeMetadata({ authToken: secret, command: secret, text: secret, method: secret }), { method: "<unknown>" });
});

test("cwd/env/spawn/log are injectable and no global cwd is hardcoded", async (t) => {
  const { server, cwd } = await serverFor(t);
  const state = await server.request("fake/state");
  assert.equal(state.cwd, realpathSync(cwd)); assert.equal(state.injected, "yes");
});

test("default environment import never launches a login shell", () => {
  let calls = 0;
  const env = { PATH: "/fake", OPENAI_API_KEY: secret };
  assert.deepEqual(childEnv(env, { spawn: () => { calls += 1; } }), env);
  assert.deepEqual(loadShellProviderEnv({ env, spawn: () => { calls += 1; } }), {});
  assert.equal(calls, 0);
});

test("explicit shell opt-in imports only provider keys using an injected shell", () => {
  const keys = loadShellProviderEnv({ optIn: true, env: { SHELL: "/fake-shell" }, spawn: (bin, args) => {
    assert.equal(bin, "/fake-shell"); assert.equal(args[0], "-lic");
    return { status: 0, stdout: `noise__AGENT_HUB_ENV_BEGIN__OPENAI_API_KEY=${secret}\0UNRELATED=${secret}\0CODEX_EMPTY=\0` };
  } });
  assert.deepEqual(keys, { OPENAI_API_KEY: secret });
});
