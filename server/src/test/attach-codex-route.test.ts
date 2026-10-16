/** Codex 接管 HTTP/WS 生产接线，不调用模型或用户会话。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { CodexDriverLinkLike, CodexDriverSendInput } from "../adapters/codex-driver.js";
import { DEFAULT_CONFIG } from "../config.js";
import { attachSessionWs, createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { HostRequestDto, SessionListItem, SystemInfo } from "../types.js";
import { saveUpload } from "../uploads.js";
import { WsHub } from "../ws.js";
import type { SessionTailManager } from "../sessions/tail.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";
import { makeFakeDashboard } from "./fakeDashboard.js";

async function fixture(options: { disabled?: boolean; auth?: boolean; locked?: boolean; archived?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "codex-route-"));
  const session: SessionListItem = { id: "codex-test", source: "codex", name: null, cwd, sessionFile: join(cwd, "rollout.jsonl"), updatedAt: new Date().toISOString(), messageCount: 0, status: "idle", isSubAgent: false, lastUserMessage: null, lastAssistantMessage: null, archived: options.archived };
  const calls = { sent: [] as CodexDriverSendInput[], aborts: 0, parallel: 0 };
  let attached = false;
  let attaching = false;
  let resolved = false;
  const request: HostRequestDto = { id: "r1", sessionId: session.id, kind: "permission", requestType: "permissions", title: "文件读取权限", detail: "只读", createdAt: Date.now(), expiresAt: null };
  const driver: CodexDriverLinkLike = {
    attach: async () => { attached = true; return { attached: true, driver: "hub", mirror: false }; },
    detach: () => { attached = attaching = false; return true; },
    isAttached: () => attached,
    isAttaching: () => attaching,
    isBusy: () => attached || attaching,
    statusFor: () => ({ online: true, attached, source: "codex", driver: "hub", mirror: false }),
    runStatusFor: () => attached ? "running" : null,
    snapshotFor: () => [],
    commandStatusFor: (_id, commandId) => commandId === "command" ? { state: "accepted", error: null } : null,
    send: (_id, input) => { calls.sent.push(input); return { id: "command", mode: "followUp" }; },
    abortTurn: () => { calls.aborts += 1; },
    listHostRequests: () => resolved ? [] : [request],
    respondHostRequest: (_id, id) => { if (id !== request.id || resolved) return false; resolved = true; return true; },
    isResolvedHostRequest: (id) => id === request.id && resolved,
    startSweep: () => {}, disposeAll: () => {},
  };
  const hub: SessionHubLike = {
    getStatus: () => "idle", listSessions: async () => [session], findSession: async (id) => id === session.id ? session : null,
    loadMessages: async () => [], search: async () => [], loadTree: async () => ({ entries: [], activePath: [] }),
    createSession: async () => session, forkSession: async () => session,
    prompt: async () => { calls.parallel += 1; return { accepted: true, mode: "prompt" }; },
    abort: async () => { calls.parallel += 1; }, compact: async () => {},
  };
  const appLock = fakeUnlockedAppLock();
  if (options.locked) appLock.status = () => ({ configured: true, webauthn: false, expiresAt: null });
  const config = { ...DEFAULT_CONFIG, auth: { enabled: !!options.auth, token: "test-only-token" } };
  const app = await createApp({ hub, config, appLock, codexDriver: options.disabled ? undefined : driver, kpi: { getCards: () => [] }, dashboard: makeFakeDashboard(), systemInfo: async () => ({} as SystemInfo), webRoot: null });
  const url = `/api/sessions/${session.id}`;
  const close = async () => { await app.close(); await rm(cwd, { recursive: true, force: true }); };
  return { app, hub, driver, config, appLock, calls, cwd, session, url, close, pending: () => { attaching = true; } };
}

test("Codex attach/message/abort/detach 与 parallel 互斥，列表策略/来源正确", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/attach` })).statusCode, 202);
    const detail = (await f.app.inject(f.url)).json();
    assert.equal(detail.session.terminal.source, "codex");
    assert.equal(detail.session.terminal.defaultPolicy, "never");
    assert.equal(detail.session.status, "running");
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/message`, payload: { text: "hello", mode: "steer", clientMessageId: "local-1" } })).statusCode, 202);
    assert.equal(f.calls.sent[0].clientMessageId, "local-1");
    assert.equal((await f.app.inject(`${f.url}/commands/command`)).json().state, "accepted");
    assert.equal((await f.app.inject(`${f.url}/commands/unknown`)).json().state, "unknown");
    const blocked = await f.app.inject({ method: "POST", url: `${f.url}/prompt`, payload: { text: "blocked" } });
    assert.equal(blocked.json().error.code, "ATTACH_ACTIVE");
    await f.app.inject({ method: "POST", url: `${f.url}/abort` });
    assert.equal(f.calls.aborts, 1);
    assert.equal(f.calls.parallel, 0);
    await f.app.inject({ method: "POST", url: `${f.url}/detach` });
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/prompt`, payload: { text: "now allowed" } })).statusCode, 202);
  } finally { await f.close(); }
});

test("准备接管期间也拒绝 parallel；abort 分发给 Codex", async () => {
  const f = await fixture();
  try {
    f.pending();
    const response = await f.app.inject({ method: "POST", url: `${f.url}/prompt`, payload: { text: "blocked" } });
    assert.equal(response.json().error.code, "ATTACH_ACTIVE");
    await f.app.inject({ method: "POST", url: `${f.url}/abort` });
    assert.equal(f.calls.aborts, 1);
  } finally { await f.close(); }
});

test("Codex 审批刷新拉取、重复应答 409、未知请求 404、非法应答 400", async () => {
  const f = await fixture();
  try {
    const requests = (await f.app.inject(`${f.url}/host-requests`)).json().requests;
    assert.equal(requests[0].requestType, "permissions");
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/host-requests/r1`, payload: { outcome: "always" } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/host-requests/r1`, payload: { outcome: "deny" } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/host-requests/r1`, payload: { outcome: "allow" } })).statusCode, 409);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/host-requests/nope`, payload: { outcome: "deny" } })).statusCode, 404);
    assert.deepEqual((await f.app.inject(`${f.url}/host-requests`)).json().requests, []);
  } finally { await f.close(); }
});

test("Codex 图片仅接收归属当前工作目录的上传引用，连同原图交给 driver", async () => {
  const f = await fixture();
  try {
    const upload = await saveUpload({ cwd: f.cwd, name: "test.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yjU8AAAAASUVORK5CYII=" });
    const response = await f.app.inject({ method: "POST", url: `${f.url}/message`, payload: { text: "看看图片", images: [upload.path] } });
    assert.equal(response.statusCode, 202);
    assert.equal((f.calls.sent[0].images as Array<{ path: string }>)[0].path, upload.path);
    const denied = await f.app.inject({ method: "POST", url: `${f.url}/message`, payload: { text: "bad", images: ["/etc/passwd"] } });
    assert.equal(denied.statusCode, 400);
    assert.equal(f.calls.sent.length, 1);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/message`, payload: { images: "not-array" } })).statusCode, 400);
  } finally { await f.close(); }
});

test("开关关闭/归档禁止接管；HTTP 鉴权与应用锁覆盖 Codex 入口", async () => {
  for (const [options, expected] of [[{ disabled: true }, 400], [{ archived: true }, 400], [{ auth: true }, 401], [{ locked: true }, 423]] as const) {
    const f = await fixture(options);
    try { assert.equal((await f.app.inject({ method: "POST", url: `${f.url}/attach` })).statusCode, expected); }
    finally { await f.close(); }
  }
});

test("生产 WS 接线：Codex 准备中拒绝 prompt，中止保留在同一 driver", async () => {
  const f = await fixture();
  const wshub = new WsHub();
  try {
    f.pending();
    const abortTurn = f.driver.abortTurn;
    f.driver.abortTurn = (id) => { abortTurn(id); wshub.broadcast(id, { type: "status", status: "idle" }); };
    attachSessionWs(f.app.server, { ...f.hub, isLive: () => true }, { wshub, config: f.config, appLock: f.appLock, codexDriver: f.driver });
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`ws://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/ws/sessions/${f.session.id}`);
    const events: Array<{ type?: string; code?: string }> = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "prompt", text: "blocked" }));
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("WS prompt 未返回冲突")), 1000); socket.on("message", () => { if (events.some((e) => e.code === "ATTACH_ACTIVE")) { clearTimeout(timer); resolve(); } }); });
    socket.send(JSON.stringify({ type: "abort" }));
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("WS abort 未完成")), 1000); socket.on("message", () => { if (f.calls.aborts === 1) { clearTimeout(timer); resolve(); } }); });
    assert.equal(f.calls.parallel, 0);
    socket.terminate();
  } finally { wshub.closeAll(); await f.close(); }
});

test("已有 WS 退出接管后恢复文件监听，重复状态不重复取得引用", async () => {
  const f = await fixture();
  const wshub = new WsHub();
  const operations: string[] = [];
  const tails = { acquire: () => operations.push("acquire"), release: () => operations.push("release"), stopAll: () => {} } as unknown as SessionTailManager;
  let socket: WebSocket | undefined;
  try {
    attachSessionWs(f.app.server, { ...f.hub, isLive: () => false }, { wshub, config: f.config, appLock: f.appLock, tails, codexDriver: f.driver });
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(`ws://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/ws/sessions/${f.session.id}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS 握手未完成")), 1000);
      socket!.on("message", (data) => { if (JSON.parse(String(data)).type === "session") { clearTimeout(timer); resolve(); } });
      socket!.once("error", reject);
    });
    wshub.broadcast(f.session.id, { type: "attach_state", attached: true, terminalOnline: true });
    wshub.broadcast(f.session.id, { type: "attach_state", attached: true, terminalOnline: true });
    wshub.broadcast(f.session.id, { type: "attach_state", attached: false, terminalOnline: false });
    wshub.broadcast(f.session.id, { type: "attach_state", attached: false, terminalOnline: false });
    assert.deepEqual(operations, ["acquire", "release", "acquire"]);
  } finally { socket?.terminate(); wshub.closeAll(); await f.close(); }
});
