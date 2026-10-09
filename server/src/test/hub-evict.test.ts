/**
 * SessionHub live map 内存驻留治理（OOM 审计 AC2/AC3）：
 * - 空闲 TTL 逐出：unsubscribe/dispose 安全释放，ensureLive 可重建（事件订阅恢复、prompt 可用）
 * - LRU 上限：超限逐出最久未用的空闲实例；运行中的实例绝不逐出（事件流语义不变）
 * - sweep 清理 feedSessions / statuses 过期条目（不再永久驻留）
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent, createAgentSession } from "@earendil-works/pi-coding-agent";
import { SessionHub } from "../sessions/hub.js";
import type { ServerEvent } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeRec {
  id: string;
  unsubscribed: number;
  disposed: number;
  idle: boolean;
  promptError: Error | null;
  promptCalls: number;
  emit: (event: AgentSessionEvent) => void;
}

/** 假 createAgentSession：每会话独立实例，记录 unsubscribe/dispose 次数与可控 isIdle */
function fakeCreate(created: FakeRec[]): typeof createAgentSession {
  return (async (opts: { sessionManager: { getSessionId?: () => string } }) => {
    const id = opts.sessionManager.getSessionId?.() ?? `anon-${created.length}`;
    let handler: ((event: AgentSessionEvent) => void) | null = null;
    const rec: FakeRec = {
      id,
      unsubscribed: 0,
      disposed: 0,
      idle: true,
      promptError: null,
      promptCalls: 0,
      emit: (event) => handler?.(event),
    };
    const session = {
      subscribe: (fn: (event: AgentSessionEvent) => void) => {
        handler = fn;
        return () => {
          handler = null;
          rec.unsubscribed += 1;
        };
      },
      get isIdle() {
        return rec.idle;
      },
      prompt: async () => {
        rec.promptCalls += 1;
        if (rec.promptError) throw rec.promptError;
      },
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      compact: async () => undefined,
      dispose: () => {
        rec.disposed += 1;
      },
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;
    created.push(rec);
    return { session };
  }) as unknown as typeof createAgentSession;
}

describe("SessionHub：live map 逐出与重建（AC2）", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-evict-"));
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    // 23 个会话文件（> LIVE_MAX=20），供 LRU 上限用例
    for (let i = 0; i < SessionHub.LIVE_MAX + 3; i += 1) {
      await writeFile(
        join(dir, enc, `s${i}.jsonl`),
        [
          JSON.stringify({ type: "session", version: 3, id: `s${i}`, timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
          JSON.stringify({
            type: "message",
            id: `u${i}`,
            parentId: null,
            timestamp: "2026-02-18T10:00:00.000Z",
            message: { role: "user", content: "hi", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
          }),
        ].join("\n"),
        "utf8",
      );
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("空闲 TTL 逐出（unsubscribe/dispose 安全释放）+ ensureLive 重建（事件流恢复、prompt 可用）", async () => {
    const created: FakeRec[] = [];
    const events: ServerEvent[] = [];
    const hub = new SessionHub(dir, (_id, event) => events.push(event), { createAgentSession: fakeCreate(created) });
    const first = await hub.ensureLive("s0");
    assert.ok(hub.isSdkLive("s0"), "ensureLive 后进入 live map");
    assert.equal(created.length, 1);

    // 推进时间过空闲 TTL → 逐出
    hub.sweep(Date.now() + SessionHub.LIVE_IDLE_TTL_MS + 1_000);
    assert.ok(!hub.isSdkLive("s0"), "空闲 TTL 过期逐出（不再常驻到重启）");
    assert.equal(created[0].unsubscribed, 1, "逐出前 unsubscribe（安全释放）");
    assert.equal(created[0].disposed, 1, "逐出前 dispose（安全释放）");

    // 重建路径不被逐出破坏：ensureLive 重新创建实例并恢复事件订阅
    const rebuilt = await hub.ensureLive("s0");
    assert.ok(hub.isSdkLive("s0"), "逐出后可重建");
    assert.equal(created.length, 2, "重建走全新实例");
    assert.notEqual(rebuilt, first);
    events.length = 0;
    created[1].emit({ type: "agent_start" } as AgentSessionEvent);
    assert.ok(
      events.some((e) => e.type === "status" && (e as { status: string }).status === "running"),
      "重建后 SDK 事件流恢复（订阅重新建立）",
    );
    const result = await hub.prompt("s0", "你好", undefined);
    await sleep(10);
    assert.equal(result.accepted, true, "重建后 prompt 照常可用");
    assert.equal(created[1].promptCalls, 1);
    hub.disposeAll();
  });

  it("LRU 上限：超限逐出最久未用的空闲实例；运行中的绝不逐出", async () => {
    const created: FakeRec[] = [];
    const hub = new SessionHub(dir, () => undefined, { createAgentSession: fakeCreate(created) });
    await hub.ensureLive("s0");
    created[0].idle = false; // s0 最旧但运行中（isIdle=false → 不可逐出）
    for (let i = 1; i <= SessionHub.LIVE_MAX + 2; i += 1) {
      await hub.ensureLive(`s${i}`);
      await sleep(3); // 让 lastUsedMs 可区分（LRU 排序确定性）
    }
    const liveCount = Array.from({ length: SessionHub.LIVE_MAX + 3 }, (_, i) => `s${i}`).filter((id) => hub.isSdkLive(id)).length;
    assert.equal(liveCount, SessionHub.LIVE_MAX, `live map 收敛到 LRU 上限 ${SessionHub.LIVE_MAX}`);
    assert.ok(hub.isSdkLive("s0"), "运行中的最旧实例 s0 不被逐出");
    for (const id of ["s1", "s2", "s3"]) {
      assert.ok(!hub.isSdkLive(id), `${id} 为最久未用的空闲实例，应被 LRU 逐出`);
    }
    assert.ok(hub.isSdkLive(`s${SessionHub.LIVE_MAX + 2}`), "最新实例保留");
    const recById = new Map(created.map((r) => [r.id, r]));
    for (const id of ["s1", "s2", "s3"]) {
      const rec = recById.get(id);
      assert.equal(rec?.unsubscribed, 1, `${id} 逐出前 unsubscribe`);
      assert.equal(rec?.disposed, 1, `${id} 逐出前 dispose`);
    }
    hub.disposeAll();
  });
});

describe("SessionHub：feedSessions / statuses 过期清扫（AC3）", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-state-"));
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    await writeFile(
      join(dir, enc, "s1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "hi", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sweep 清理过期 feedSessions 条目与过期 statuses 条目（不再残留）", async () => {
    const created: FakeRec[] = [];
    const hub = new SessionHub(dir, () => undefined, { createAgentSession: fakeCreate(created) });
    const t0 = Date.now();
    hub.markLiveFeed("f1", t0);
    assert.ok(hub.isLive("f1", t0), "feed 标记后视为 live");
    assert.ok(hub.isLive("f1", t0 + SessionHub.FEED_TTL_MS - 1_000), "TTL 内 feed 生效");

    // 失败 run 留下 error 状态条目（非 idle，过期前保留）
    await hub.ensureLive("s1");
    created[0].promptError = new Error("boom");
    await hub.prompt("s1", "hi", undefined);
    await sleep(10);
    assert.equal(hub.getStatus("s1"), "error", "失败 run 留下 error 状态条目");

    // 推进时间清扫：feed 过期 + 非 idle 状态过期（余量盖过用例内的 setup 耗时）
    hub.sweep(t0 + SessionHub.STATE_TTL_MS + 60_000);
    assert.ok(
      !hub.isLive("f1", t0 + SessionHub.FEED_TTL_MS - 1_000),
      "feedSessions 过期条目已清（窗口内回看不再视为 live）",
    );
    assert.equal(hub.getStatus("s1"), "idle", "statuses 过期条目已清（回默认 idle）");
    hub.disposeAll();
  });
});

describe("SessionHub：ensureLive 并发互斥（per-id inflight 单实例）", () => {
  it("并发 ensureLive 只创建一个 AgentSession（不双开、事件订阅不重复）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-inflight-"));
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    await writeFile(
      join(dir, enc, "c1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "c1", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "hi", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
    const created: FakeRec[] = [];
    const hub = new SessionHub(dir, () => undefined, { createAgentSession: fakeCreate(created) });
    try {
      // 并发 prompt/ensureLive 会同时穿过 await findSession 的间隙：旧实现双开两个实例
      // （事件双推送 + 潜在文件损坏）
      const [a, b, c] = await Promise.all([hub.ensureLive("c1"), hub.ensureLive("c1"), hub.ensureLive("c1")]);
      assert.equal(created.length, 1, "并发 ensureLive 只创建一个 AgentSession");
      assert.equal(a, b, "并发调用拿到同一实例");
      assert.equal(b, c, "并发调用拿到同一实例");
      assert.ok(hub.isSdkLive("c1"));
      // 失败路径的 inflight 不残留：不存在的会话并发调用都失败
      await assert.rejects(
        () => Promise.all([hub.ensureLive("nope-x"), hub.ensureLive("nope-x")]),
        (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
      );
      // 成功后走已存在实例（不重复创建）
      const d = await hub.ensureLive("c1");
      assert.equal(d, a);
      assert.equal(created.length, 1, "后续调用复用已有实例");
    } finally {
      hub.disposeAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
