import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import { SessionHub } from "../sessions/hub.js";
import { parsePiModel, PiModels, recordedPiModel, type PiResolvedModel, type PiRuntime } from "../sessions/models.js";
import type { PiModelRef } from "../types.js";

const grok = { provider: "xai", id: "grok-4.5", name: "Grok 4.5", api: "openai-completions",
  baseUrl: "https://private.invalid", apiKey: "private-token", headers: { Authorization: "private-token" } } as unknown as PiResolvedModel;
const claude = { ...grok, provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude" } as PiResolvedModel;
const ref: PiModelRef = { provider: "xai", id: "grok-4.5" };
const runtime: PiRuntime = {
  getModels: () => [grok, claude], getAvailableSnapshot: () => [grok], getError: () => undefined,
  getModel: (provider, id) => [grok, claude].find((model) => model.provider === provider && model.id === id),
};
const models = () => new PiModels({ runtime: async () => runtime, defaults: () => ({ provider: "anthropic", id: claude.id }) });

describe("pi model identifiers and active branch", () => {
  it("accepts explicit provider/id, including slash model IDs, and rejects credential/config fields", () => {
    assert.deepEqual(parsePiModel({ provider: " xai ", id: " grok-4.5 " }), ref);
    assert.deepEqual(parsePiModel({ provider: "openrouter", id: "x-ai/grok:latest" }), { provider: "openrouter", id: "x-ai/grok:latest" });
    for (const value of [null, [], "xai/grok-4.5", {}, { provider: "xai", id: "" }, { ...ref, apiKey: "private-token" }, { ...ref, id: "bad\nname" }]) {
      assert.throws(() => parsePiModel(value), (err) => err instanceof HubError && err.code === ErrorCodes.INVALID_REQUEST);
    }
  });

  it("reads the active branch and keeps a virtual selection ahead of the physical response model", () => {
    const content = [
      { type: "session", id: "s", version: 3 },
      { type: "model_change", id: "a", parentId: null, provider: "virtual", modelId: "router" },
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", provider: "xai", model: "grok-4.5" } },
      { type: "model_change", id: "abandoned", parentId: "a", provider: "anthropic", modelId: "unwanted" },
      { type: "session_info", id: "last", parentId: "b", name: "Kept branch" },
    ].map((line) => JSON.stringify(line)).join("\n");
    assert.deepEqual(recordedPiModel(content), { model: { provider: "virtual", id: "router" }, leafId: "last" });
  });
});

describe("pi models and model switching", () => {
  let directory: string, cwd: string;
  const hubs: SessionHub[] = [];
  before(async () => { directory = await mkdtemp(join(tmpdir(), "hub-pi-models-")); cwd = await mkdtemp(join(tmpdir(), "hub-pi-cwd-")); });
  after(async () => { hubs.forEach((hub) => hub.disposeAll()); await rm(directory, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); });
  function hub(create?: typeof createAgentSession, externalActive?: () => boolean) {
    const item = new SessionHub(directory, () => undefined, { models: models(), createAgentSession: create, externalActive });
    hubs.push(item); return item;
  }

  it("exposes only configured model metadata and reports a missing saved default without leaking endpoint/auth fields", async () => {
    const catalog = await models().catalog(cwd);
    assert.deepEqual(catalog.models, [{ provider: "xai", id: "grok-4.5", name: "Grok 4.5" }]);
    assert.deepEqual(catalog.defaultModel, { provider: "anthropic", id: claude.id });
    assert.match(catalog.warning!, /默认模型.*不可用/);
    assert.doesNotMatch(JSON.stringify(catalog), /private-token|private.invalid|apiKey|Authorization|baseUrl/);
    await assert.rejects(models().resolve({ provider: "anthropic", id: claude.id }), (error) => error instanceof HubError && error.code === ErrorCodes.MODEL_UNAVAILABLE);
  });

  it("pins a newly selected model before the first message instead of using an unrelated global default", async () => {
    let chosen: unknown;
    const create = (async (options) => {
      chosen = options?.model;
      return { session: { model: options?.model, modelRuntime: runtime, isIdle: true, subscribe: () => () => undefined, dispose() {} } as unknown as AgentSession, extensionsResult: {} };
    }) as typeof createAgentSession;
    const item = hub(create);
    const session = await item.createSession(cwd, "Use Grok", ref);
    const content = await readFile(session.sessionFile, "utf8");
    assert.deepEqual(recordedPiModel(content).model, ref);
    assert.match(content, /Use Grok/);
    await item.ensureLive(session.id);
    assert.equal(chosen, grok);
    assert.deepEqual((await item.getModels(cwd, session.id)).currentModel, ref);
  });

  it("changes an idle cold session by appending metadata; history and saved defaults remain untouched", async () => {
    const item = hub();
    const session = await item.createSession(cwd, "Keep history");
    const previous = await readFile(session.sessionFile, "utf8");
    const defaultsBefore = (await models().catalog(cwd)).defaultModel;
    await item.setModel(session.id, ref);
    const after = await readFile(session.sessionFile, "utf8");
    assert.ok(after.startsWith(previous));
    assert.equal(after.split("\n").filter(Boolean).length, previous.split("\n").filter(Boolean).length + 1);
    assert.deepEqual(recordedPiModel(after).model, ref);
    assert.deepEqual((await models().catalog(cwd)).defaultModel, defaultsBefore);
    assert.deepEqual((await item.getModels(cwd, session.id)).currentModel, ref);
  });

  it("switches a loaded idle SDK session with persist:false and permits an immediate send", async () => {
    let persist: unknown, sent = 0;
    let activeModel = claude;
    const fake = { get model() { return activeModel; }, modelRuntime: runtime, isIdle: true, subscribe: () => () => undefined,
      setModel: async (model: PiResolvedModel, options: unknown) => { activeModel = model; persist = options; },
      prompt: async () => { sent += 1; }, dispose() {} } as unknown as AgentSession;
    const item = hub((async () => ({ session: fake })) as unknown as typeof createAgentSession);
    const session = await item.createSession(cwd);
    await item.ensureLive(session.id);
    await item.setModel(session.id, ref);
    assert.deepEqual(persist, { persist: false });
    assert.deepEqual((await item.getModels(cwd, session.id)).currentModel, ref);
    assert.equal((await item.prompt(session.id, "Continue", undefined)).accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sent, 1);
  });

  it("refuses writes while an external terminal owns the session", async () => {
    const item = hub(undefined, () => true);
    const session = await item.createSession(cwd);
    const before = await readFile(session.sessionFile, "utf8");
    await assert.rejects(item.setModel(session.id, ref), (error) => error instanceof HubError && error.code === ErrorCodes.EXTERNAL_ACTIVE);
    assert.equal(await readFile(session.sessionFile, "utf8"), before);
  });

  it("invalid choices do not create a session or overwrite an existing model", async () => {
    const item = hub();
    await assert.rejects(item.createSession(cwd, undefined, { provider: "xai", id: "missing" }), (error) => error instanceof HubError && error.code === ErrorCodes.MODEL_UNAVAILABLE);
    const session = await item.createSession(cwd, undefined, ref);
    const before = await readFile(session.sessionFile, "utf8");
    await assert.rejects(item.setModel(session.id, { provider: "xai", id: "missing" }));
    assert.equal(await readFile(session.sessionFile, "utf8"), before);
  });

  it("reading the model does not migrate or write the session, including a legacy flat history", async () => {
    const item = hub();
    const session = await item.createSession(cwd);
    const legacy = [
      { type: "session", version: 1, id: session.id, cwd, timestamp: new Date(0).toISOString() },
      { type: "message", timestamp: new Date(0).toISOString(), message: { role: "user", content: "Keep old context" } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(session.sessionFile, legacy); await utimes(session.sessionFile, new Date(0), new Date(0));
    const before = await stat(session.sessionFile);
    await item.getModels(cwd, session.id);
    assert.equal(await readFile(session.sessionFile, "utf8"), legacy);
    assert.equal((await stat(session.sessionFile)).mtimeMs, before.mtimeMs);
    await item.setModel(session.id, ref);
    const context = SessionManager.open(session.sessionFile).buildSessionContext();
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].role, "user");
    assert.deepEqual(recordedPiModel(await readFile(session.sessionFile, "utf8")).model, ref);
  });

  it("serializes model changes with sends and SDK startup", async () => {
    let release!: (value: PiRuntime) => void;
    const waiting = new PiModels({ runtime: () => new Promise((resolve) => { release = resolve; }) });
    const item = new SessionHub(directory, () => {}, { models: waiting }); hubs.push(item);
    const session = await item.createSession(cwd);
    const changing = item.setModel(session.id, ref);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(item.prompt(session.id, "Cannot race", undefined), (err) => err instanceof HubError && err.code === ErrorCodes.SESSION_BUSY);
    await assert.rejects(item.ensureLive(session.id), (err) => err instanceof HubError && err.code === ErrorCodes.SESSION_BUSY);
    await assert.rejects(item.setModel(session.id, ref));
    release(runtime); await changing;
    assert.equal(await item.externalBusyReason(session.id), null);
  });

  it("rejects changing a model after prompt acceptance even before the SDK is ready", async () => {
    let release!: (value: unknown) => void;
    const creating = new Promise((resolve) => { release = resolve; });
    const create = (async () => {
      await creating;
      return { session: { model: grok, isIdle: true, subscribe: () => () => {}, prompt: async () => {}, dispose() {} } as unknown as AgentSession };
    }) as unknown as typeof createAgentSession;
    const item = hub(create); const session = await item.createSession(cwd);
    assert.equal((await item.prompt(session.id, "Run", undefined)).accepted, true);
    await assert.rejects(item.setModel(session.id, ref), (err) => err instanceof HubError && err.code === ErrorCodes.SESSION_BUSY);
    release(undefined);
    await item.ensureLive(session.id);
  });

  it("does not evict an idle SDK while it is applying a model change", async () => {
    let finish!: () => void, disposed = false;
    const applying = new Promise<void>((resolve) => { finish = resolve; });
    let entered = false;
    const fake = { model: grok, modelRuntime: runtime, isIdle: true, subscribe: () => () => {},
      setModel: async () => { entered = true; await applying; }, dispose: () => { disposed = true; } } as unknown as AgentSession;
    const item = hub((async () => ({ session: fake })) as unknown as typeof createAgentSession);
    const session = await item.createSession(cwd); await item.ensureLive(session.id);
    const changing = item.setModel(session.id, ref);
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    item.sweep(Date.now() + SessionHub.LIVE_IDLE_TTL_MS + 1000);
    assert.equal(disposed, false); finish(); await changing;
  });

  it("rechecks terminal ownership after asynchronous model resolution", async () => {
    let release!: (value: PiRuntime) => void, terminalOnline = false;
    const item = new SessionHub(directory, () => {}, { externalActive: () => terminalOnline,
      models: new PiModels({ runtime: () => new Promise((resolve) => { release = resolve; }) }) }); hubs.push(item);
    const session = await item.createSession(cwd);
    const before = await readFile(session.sessionFile, "utf8");
    const changing = item.setModel(session.id, ref);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    terminalOnline = true; release(runtime);
    await assert.rejects(changing, (err) => err instanceof HubError && err.code === ErrorCodes.EXTERNAL_ACTIVE);
    assert.equal(await readFile(session.sessionFile, "utf8"), before);
  });

  it("real bundled SDK honors an empty session's Grok selection and persist:false keeps saved defaults unchanged", async () => {
    const agentDir = join(directory, "isolated-profile"); await mkdir(agentDir);
    const settingsFile = join(agentDir, "settings.json");
    const settingsText = JSON.stringify({ defaultProvider: "anthropic", defaultModel: claude.id });
    await writeFile(settingsFile, settingsText);
    const realRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "catalog-cache.json"), allowModelNetwork: false });
    await realRuntime.setRuntimeApiKey("xai", "fixture-only-not-a-real-key");
    const isolatedModels = new PiModels({ runtime: async () => realRuntime,
      defaults: () => ({ provider: "anthropic", id: claude.id }) });
    const item = new SessionHub(directory, () => {}, { models: isolatedModels,
      createAgentSession: (options) => createAgentSession({ ...options, agentDir, tools: [],
        settingsManager: SettingsManager.create(cwd, agentDir) }) }); hubs.push(item);
    const session = await item.createSession(cwd, "Real SDK, no provider calls", ref);
    const live = await item.ensureLive(session.id);
    assert.deepEqual({ provider: live.model?.provider, id: live.model?.id }, ref);
    await item.setModel(session.id, { provider: "xai", id: "grok-4.3" });
    assert.equal(live.model?.id, "grok-4.3");
    assert.equal(await readFile(settingsFile, "utf8"), settingsText);
    assert.deepEqual(recordedPiModel(await readFile(session.sessionFile, "utf8")).model, { provider: "xai", id: "grok-4.3" });
  });

  it("a stale model restore cannot silently fall back to another provider", async () => {
    let disposed = false;
    const fake = { model: claude, dispose: () => { disposed = true; } } as unknown as AgentSession;
    const item = hub((async () => ({ session: fake, modelFallbackMessage: "Could not restore model" })) as unknown as typeof createAgentSession);
    const session = await item.createSession(cwd, undefined, ref);
    const initial = await readFile(session.sessionFile, "utf8");
    const leafId = recordedPiModel(initial).leafId;
    await writeFile(session.sessionFile, initial + JSON.stringify({ type: "message", id: "old-user", parentId: leafId,
      timestamp: new Date().toISOString(), message: { role: "user", content: "Keep this context" } }) + "\n");
    await assert.rejects(item.ensureLive(session.id), (error) => error instanceof HubError && error.code === ErrorCodes.MODEL_UNAVAILABLE);
    assert.equal(disposed, true);
    assert.match(await readFile(session.sessionFile, "utf8"), /Keep this context/);
  });
});
