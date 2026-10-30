import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentCommandHub } from "../agents.js";
import { SessionRegistry } from "../adapters/registry.js";
import type { SessionAdapter } from "../adapters/types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { ErrorCodes, HubError } from "../errors.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { PiModelCatalog, PiModelRef, SessionListItem, SystemInfo } from "../types.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";
import { makeFakeDashboard } from "./fakeDashboard.js";

const model: PiModelRef = { provider: "xai", id: "grok-4.5" };
const catalog: PiModelCatalog = { models: [{ ...model, name: "Grok 4.5" }], currentModel: model,
  defaultModel: { provider: "anthropic", id: "unavailable-default" }, warning: null };
const session: SessionListItem = { id: "pi-model-session", source: "pi", name: null, cwd: "/tmp",
  sessionFile: "/tmp/pi-model-session.jsonl", updatedAt: new Date(0).toISOString(), messageCount: 0,
  status: "idle", isSubAgent: false, lastUserMessage: null, lastAssistantMessage: null };

async function fixture(options: { locked?: boolean; auth?: boolean; unsupported?: boolean; attached?: boolean } = {}) {
  const calls = { changes: [] as PiModelRef[], creates: [] as unknown[][], cwd: "" };
  const hub: SessionHubLike = {
    getStatus: () => "idle", listSessions: async () => [session], findSession: async () => session,
    loadMessages: async () => [], search: async () => [], loadTree: async () => ({ entries: [], activePath: [] }),
    createSession: async (...args) => { calls.creates.push(args); return session; }, forkSession: async () => session,
    prompt: async () => ({ accepted: true, mode: "prompt" }), abort: async () => {}, compact: async () => {},
    ...(!options.unsupported ? {
      getPiModels: async (cwd: string) => { calls.cwd = cwd; return catalog; },
      getSessionModels: async () => catalog,
      setPiModel: async (_id: string, choice: PiModelRef) => { calls.changes.push(choice); return choice; },
    } : {}),
  };
  const agents = new AgentCommandHub();
  if (options.attached) {
    agents.heartbeat({ sessionId: session.id, pid: 123, cwd: session.cwd });
    await agents.poll(session.id, 0); agents.attach(session.id);
  }
  const app = await createApp({ hub, dashboard: makeFakeDashboard(), kpi: { getCards: () => [] },
    config: { ...DEFAULT_CONFIG, workspaceRoot: "/tmp", auth: { enabled: !!options.auth, token: "test-only" } },
    systemInfo: async () => ({} as SystemInfo), webRoot: null, agents,
    appLock: { ...fakeUnlockedAppLock(), status: () => ({ configured: !!options.locked, webauthn: false, expiresAt: null }) },
  });
  return { app, calls, close: async () => { await app.close(); agents.close(); } };
}

test("pi models: catalog and current/default identities have separate fields", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject("/api/pi/models?cwd=%2Ftmp");
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), catalog); assert.equal(f.calls.cwd, "/tmp");
    assert.deepEqual((await f.app.inject(`/api/sessions/${session.id}/model`)).json(), catalog);
    assert.equal((await f.app.inject("/api/pi/models?cwd=relative")).statusCode, 400);
    assert.equal((await f.app.inject("/api/pi/models")).statusCode, 200);
  } finally { await f.close(); }
});

test("pi models: create accepts only explicit pi provider/id, and switching never sends a prompt", async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "/tmp", name: "Grok", model } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(f.calls.creates, [["/tmp", "Grok", "pi", model]]);
    const changed = await f.app.inject({ method: "POST", url: `/api/sessions/${session.id}/model`, payload: model });
    assert.equal(changed.statusCode, 200); assert.deepEqual(changed.json(), { model });
    for (const payload of [{ ...model, apiKey: "not-accepted" }, { provider: "xai" }, { model }, {}]) {
      assert.equal((await f.app.inject({ method: "POST", url: `/api/sessions/${session.id}/model`, payload })).statusCode, 400);
    }
    for (const source of ["claude", "codex"]) {
      assert.equal((await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "/tmp", source, model } })).statusCode, 400);
    }
    assert.equal(f.calls.changes.length, 1); assert.equal(f.calls.creates.length, 1);
  } finally { await f.close(); }
});

test("pi model routes keep bearer authentication, app lock, and terminal takeover protection", async () => {
  for (const [options, expected] of [[{ auth: true }, 401], [{ locked: true }, 423]] as const) {
    const f = await fixture(options);
    try {
      for (const url of ["/api/pi/models?cwd=%2Ftmp", `/api/sessions/${session.id}/model`]) {
        assert.equal((await f.app.inject(url)).statusCode, expected);
      }
      assert.equal((await f.app.inject({ method: "POST", url: `/api/sessions/${session.id}/model`, payload: model })).statusCode, expected);
      assert.equal(f.calls.changes.length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture({ attached: true });
  try {
    const response = await f.app.inject({ method: "POST", url: `/api/sessions/${session.id}/model`, payload: model });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, "ATTACH_ACTIVE");
    assert.match(response.json().error.message, /切换模型/); assert.equal(f.calls.changes.length, 0);
  } finally { await f.close(); }
});

test("pi model routes report unsupported implementations without guessing or changing config", async () => {
  const f = await fixture({ unsupported: true });
  try {
    assert.equal((await f.app.inject("/api/pi/models")).statusCode, 501);
    assert.equal((await f.app.inject(`/api/sessions/${session.id}/model`)).statusCode, 501);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/sessions/${session.id}/model`, payload: model })).statusCode, 501);
  } finally { await f.close(); }
});

test("pi model registry never routes Claude/Codex model changes through pi", async () => {
  let changes = 0;
  function adapter(source: "pi" | "claude" | "codex"): SessionAdapter {
    const item = { ...session, source, id: source };
    return { source, listSessions: async () => [item], findSession: async (id) => id === source ? item : null,
      getStatus: () => "idle", loadMessages: async () => [], isLive: () => false,
      prompt: async () => ({ accepted: true, mode: "prompt" }), abort: async () => {}, compact: async () => {},
      forkSession: async () => item, disposeAll: () => {},
      getModels: async () => catalog, setModel: async (_id, choice) => { changes++; return choice; },
    };
  }
  const registry = new SessionRegistry(adapter("pi"), adapter("claude"), "", adapter("codex"));
  try {
    for (const id of ["claude", "codex"]) {
      await assert.rejects(registry.setPiModel(id, model), (error) => error instanceof HubError && error.code === ErrorCodes.INVALID_REQUEST);
      await assert.rejects(registry.getSessionModels(id));
    }
    assert.deepEqual(await registry.setPiModel("pi", model), model); assert.equal(changes, 1);
  } finally { registry.disposeAll(); }
});
