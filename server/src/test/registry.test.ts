/**
 * SessionRegistry 单测：多 source 合并排序 + prompt/abort/compact 按 id 分发路由。
 * 适配器用 fake 注入（不碰真实磁盘/进程）。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SessionRegistry } from "../adapters/registry.js";
import type { SessionAdapter } from "../adapters/types.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, SessionListItem, SessionSource, SessionStatus } from "../types.js";

interface Call {
  method: string;
  args: unknown[];
}

function makeItem(id: string, source: SessionSource, updatedAt: string): SessionListItem {
  return {
    id,
    source,
    name: null,
    cwd: "/tmp/demo",
    updatedAt,
    messageCount: 0,
    status: "idle",
    lastUserMessage: null,
    lastAssistantMessage: null,
    sessionFile: `/tmp/${id}.jsonl`,
    isSubAgent: false,
  };
}

interface FakeAdapter extends SessionAdapter {
  calls: Call[];
  status: SessionStatus;
}

function makeFakeAdapter(
  source: SessionSource,
  sessions: SessionListItem[],
  promptResult: PromptResult = { accepted: true, mode: "prompt" },
): FakeAdapter {
  const calls: Call[] = [];
  const state = { status: "idle" as SessionStatus };
  return {
    source,
    calls,
    get status(): SessionStatus {
      return state.status;
    },
    set status(v: SessionStatus) {
      state.status = v;
    },
    isLive: () => false,
    getStatus: () => state.status,
    listSessions: async () => {
      calls.push({ method: "listSessions", args: [] });
      return sessions;
    },
    findSession: async (id: string) => {
      calls.push({ method: "findSession", args: [id] });
      return sessions.find((s) => s.id === id) ?? null;
    },
    loadMessages: async (id: string): Promise<MessageDto[]> => {
      calls.push({ method: "loadMessages", args: [id] });
      return [];
    },
    prompt: async (id: string, text: unknown, modeRaw: unknown) => {
      calls.push({ method: "prompt", args: [id, text, modeRaw] });
      return promptResult;
    },
    abort: async (id: string) => {
      calls.push({ method: "abort", args: [id] });
    },
    createSession: async (cwd: string, name?: string) => {
      calls.push({ method: "createSession", args: [cwd, name] });
      return sessions[0];
    },
    forkSession: async (id: string) => {
      calls.push({ method: "forkSession", args: [id] });
      return sessions.find((s) => s.id === id) ?? sessions[0];
    },
    disposeAll: () => {
      calls.push({ method: "disposeAll", args: [] });
    },
  } as FakeAdapter;
}

describe("registry: createSession 按 source 分发 / forkSession 按归属分发", () => {
  it("createSession 缺省走 pi，source=claude 走 claude 适配器", () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(piAdapter, claudeAdapter);
    void registry.createSession("/tmp/demo", "默认");
    void registry.createSession("/tmp/demo", "claude 的", "claude");
    assert.deepEqual(
      piAdapter.calls.filter((c) => c.method === "createSession").map((c) => c.args),
      [["/tmp/demo", "默认"]],
    );
    assert.deepEqual(
      claudeAdapter.calls.filter((c) => c.method === "createSession").map((c) => c.args),
      [["/tmp/demo", "claude 的"]],
    );
  });

  it("forkSession 按 id 归属分发到对应适配器（claude 优先于 pi）", async () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(piAdapter, claudeAdapter);

    const fromClaude = await registry.forkSession("claude-1");
    assert.equal(fromClaude.id, "claude-1");
    assert.equal(claudeAdapter.calls.filter((c) => c.method === "forkSession").length, 1);
    assert.equal(piAdapter.calls.filter((c) => c.method === "forkSession").length, 0);

    const fromPi = await registry.forkSession("pi-1");
    assert.equal(fromPi.id, "pi-1");
    assert.equal(piAdapter.calls.filter((c) => c.method === "forkSession").length, 1);
  });

  it("forkSession 两边都未命中 → SESSION_NOT_FOUND", async () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(piAdapter, claudeAdapter);
    await assert.rejects(
      () => registry.forkSession("nope"),
      (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
    );
  });
});

describe("registry: renameSession 按归属分发", () => {
  it("分发到归属 adapter，name 原样透传（空串 = 清空）", async () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const renamed: Array<{ id: string; name: string }> = [];
    Object.assign(claudeAdapter, {
      renameSession: async (id: string, name: string) => {
        renamed.push({ id, name });
        return { ...makeItem(id, "claude", "2026-02-18T11:00:00.000Z"), name: name === "" ? null : name };
      },
    });
    const registry = new SessionRegistry(piAdapter, claudeAdapter);

    const out = await registry.renameSession("claude-1", "新名");
    assert.equal(out.name, "新名");
    const cleared = await registry.renameSession("claude-1", "");
    assert.equal(cleared.name, null);
    assert.deepEqual(renamed, [
      { id: "claude-1", name: "新名" },
      { id: "claude-1", name: "" },
    ]);
    assert.equal(piAdapter.calls.filter((c) => c.method === "renameSession").length, 0);
  });

  it("适配器未实现 renameSession（如 codex）→ INVALID_REQUEST(400)，不静默成功", async () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(piAdapter, claudeAdapter);
    await assert.rejects(
      () => registry.renameSession("claude-1", "x"),
      (err: unknown) => (err as { code?: string }).code === "INVALID_REQUEST",
    );
  });

  it("renameSession 会话不存在 → SESSION_NOT_FOUND", async () => {
    const piAdapter = makeFakeAdapter("pi", [makeItem("pi-1", "pi", "2026-02-18T12:00:00.000Z")]);
    const claudeAdapter = makeFakeAdapter("claude", [makeItem("claude-1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(piAdapter, claudeAdapter);
    await assert.rejects(
      () => registry.renameSession("nope", "x"),
      (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
    );
  });
});

describe("registry: 合并两个 source 的会话列表", () => {
  it("pi + claude 合并且按 updatedAt 倒序（同刻按 id 稳定排序）", async () => {
    const pi = makeFakeAdapter("pi", [
      makeItem("p-old", "pi", "2026-02-18T10:00:00.000Z"),
      makeItem("p-mid", "pi", "2026-02-18T11:00:00.000Z"),
    ]);
    const claude = makeFakeAdapter("claude", [
      makeItem("c-new", "claude", "2026-02-18T12:00:00.000Z"),
      makeItem("c-tie-b", "claude", "2026-02-18T11:00:00.000Z"),
    ]);
    const registry = new SessionRegistry(pi, claude);
    const sessions = await registry.listSessions();
    assert.deepEqual(
      sessions.map((s) => s.id),
      ["c-new", "c-tie-b", "p-mid", "p-old"],
    );
    assert.deepEqual(
      sessions.map((s) => s.source),
      ["claude", "claude", "pi", "pi"],
    );
  });

  it("一源为空不影响另一源（优雅降级）", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T10:00:00.000Z")]);
    const claude = makeFakeAdapter("claude", []);
    const registry = new SessionRegistry(pi, claude);
    const sessions = await registry.listSessions();
    assert.deepEqual(
      sessions.map((s) => s.id),
      ["p1"],
    );
  });
});

describe("registry: prompt 按 id 分发路由", () => {
  it("claude 会话 id → claude.prompt；pi 会话 id → pi.prompt（参数透传）", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T10:00:00.000Z")]);
    const claude = makeFakeAdapter("claude", [makeItem("c1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(pi, claude);

    const r1 = await registry.prompt("c1", "hello", "steer");
    assert.equal(r1.accepted, true);
    assert.deepEqual(claude.calls.filter((c) => c.method === "prompt").map((c) => c.args), [["c1", "hello", "steer"]]);
    assert.equal(pi.calls.filter((c) => c.method === "prompt").length, 0);

    const r2 = await registry.prompt("p1", "world", undefined);
    assert.equal(r2.accepted, true);
    assert.deepEqual(pi.calls.filter((c) => c.method === "prompt").map((c) => c.args), [["p1", "world", undefined]]);
    assert.equal(claude.calls.filter((c) => c.method === "prompt").length, 1);
  });

  it("busy 结果透传（409 语义由 routes 处理）", async () => {
    const pi = makeFakeAdapter("pi", []);
    const claude = makeFakeAdapter("claude", [makeItem("c1", "claude", "2026-02-18T11:00:00.000Z")], {
      accepted: false,
      mode: "prompt",
      busy: true,
    });
    const registry = new SessionRegistry(pi, claude);
    const result = await registry.prompt("c1", "hi", undefined);
    assert.equal(result.busy, true);
  });

  it("未知 id → SESSION_NOT_FOUND（404）", async () => {
    const registry = new SessionRegistry(makeFakeAdapter("pi", []), makeFakeAdapter("claude", []));
    await assert.rejects(
      () => registry.prompt("nope", "hi", undefined),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "SESSION_NOT_FOUND");
        assert.equal((err as { statusCode: number }).statusCode, 404);
        return true;
      },
    );
  });

  it("abort 按 id 分发；未知 id 幂等不抛", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T10:00:00.000Z")]);
    const claude = makeFakeAdapter("claude", [makeItem("c1", "claude", "2026-02-18T11:00:00.000Z")]);
    const registry = new SessionRegistry(pi, claude);
    await registry.abort("c1");
    await registry.abort("p1");
    await registry.abort("nope");
    assert.deepEqual(claude.calls.filter((c) => c.method === "abort").map((c) => c.args), [["c1"]]);
    assert.deepEqual(pi.calls.filter((c) => c.method === "abort").map((c) => c.args), [["p1"]]);
  });
});

describe("registry: compact / getStatus 归属", () => {
  it("compact 仅支持 pi；claude 会话返回 INVALID_REQUEST", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T10:00:00.000Z")]);
    (pi as { compact?: (id: string) => Promise<void> }).compact = async (id: string) => {
      pi.calls.push({ method: "compact", args: [id] });
    };
    const claude = makeFakeAdapter("claude", [makeItem("c1", "claude", "2026-02-18T11:00:00.000Z")]);
    // claude 适配器不实现 compact（由其自身 autocompact 管理）
    const registry = new SessionRegistry(pi, claude);
    await assert.rejects(
      () => registry.compact("c1"),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "INVALID_REQUEST");
        return true;
      },
    );
    await registry.compact("p1");
    assert.deepEqual(pi.calls.filter((c) => c.method === "compact").map((c) => c.args), [["p1"]]);
    await assert.rejects(
      () => registry.compact("nope"),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "SESSION_NOT_FOUND");
        return true;
      },
    );
  });

  it("getStatus/isLive 路由到归属 source（findSession 后记账）", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T10:00:00.000Z")]);
    pi.status = "idle";
    const claude = makeFakeAdapter("claude", [makeItem("c1", "claude", "2026-02-18T11:00:00.000Z")]);
    claude.status = "running";
    const registry = new SessionRegistry(pi, claude);
    assert.equal(registry.getStatus("c1"), "idle"); // 未记账前默认 pi 路径
    await registry.findSession("c1");
    assert.equal(registry.getStatus("c1"), "running");
    await registry.findSession("p1");
    assert.equal(registry.getStatus("p1"), "idle");
    assert.equal(registry.isLive("c1"), false);
    assert.equal(registry.isLive("p1"), false);
  });
});

describe("registry: 写路径联动缓存立即可见（改名/新建不滞后 5-20s）", () => {
  it("renameSession/createSession 后 listSessions 立即返回新数据（不走 SWR 旧值）", async () => {
    const items = [makeItem("p1", "pi", "2026-02-18T12:00:00.000Z")];
    const pi = makeFakeAdapter("pi", items);
    Object.assign(pi, {
      renameSession: async (id: string, name: string) => {
        pi.calls.push({ method: "renameSession", args: [id, name] });
        items[0] = { ...items[0], name: name === "" ? null : name };
        return items[0];
      },
      createSession: async (cwd: string, name?: string) => {
        pi.calls.push({ method: "createSession", args: [cwd, name] });
        const created = makeItem("p-new", "pi", "2026-02-18T12:30:00.000Z");
        created.name = name ?? null;
        items.push(created);
        return created;
      },
    });
    const registry = new SessionRegistry(pi, makeFakeAdapter("claude", []));

    const first = await registry.listSessions();
    assert.equal(first.find((s) => s.id === "p1")?.name, null, "初始缓存 name 为空");

    // 改名（写路径）：旧实现 SWR 旧值秒回 + 最小重扫间隔 → 名字滞后 5-20s 才可见
    const renamed = await registry.renameSession("p1", "新名字");
    assert.equal(renamed.name, "新名字");
    const afterRename = await registry.listSessions();
    assert.equal(afterRename.find((s) => s.id === "p1")?.name, "新名字", "改名后列表立即可见（不等 TTL）");

    // 新建（写路径）同理
    const created = await registry.createSession("/tmp/demo", "崭新会话");
    assert.equal(created.id, "p-new");
    const afterCreate = await registry.listSessions();
    assert.ok(afterCreate.some((s) => s.id === "p-new" && s.name === "崭新会话"), "新建后列表立即可见（不等 TTL）");
  });

  it("presence 的 invalidateList()（无参）仍走 SWR：旧值秒回不被清空", async () => {
    const pi = makeFakeAdapter("pi", [makeItem("p1", "pi", "2026-02-18T12:00:00.000Z")]);
    const registry = new SessionRegistry(pi, makeFakeAdapter("claude", []));
    const first = await registry.listSessions();
    registry.invalidateList(); // 文件变更（presence）高频路径：必须保持秒回语义
    const second = await registry.listSessions();
    assert.deepEqual(second, first, "SWR 语义不变：旧缓存秒回（后台再刷新）");
  });
});
