/**
 * parallel 路径（手机继续不活跃会话）的流式推送测试：delta 节流合并 + WS 背压。
 *
 * 修复前的问题（实测/读码确认）：
 * - attach 路径有 LiveIngest 的 100ms delta 合并，parallel 路径（SessionHub.handleSdkEvent）
 *   却每个 SDK chunk 直接 emit、一帧不合并——而 parallel 恰恰是「手机继续不活跃会话」走的路，
 *   弱网下帧数放大数十倍。
 * - WsHub.broadcast 只查 readyState === OPEN，不看 bufferedAmount：快模型 + 慢客户端
 *   会让 server 的发送缓冲无上界增长。
 *
 * 两条路径现在共用 EventThrottle（live.ts）这一个实现，防口径漂移。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent, createAgentSession } from "@earendil-works/pi-coding-agent";
import { EventThrottle, coalesceDeltas } from "../live.js";
import { SessionHub } from "../sessions/hub.js";
import type { ServerEvent } from "../types.js";
import { isDroppableEvent, shouldDropUnderBackpressure, WS_BACKPRESSURE_BYTES } from "../ws.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("EventThrottle：delta 合并与保序（attach / parallel 共用）", () => {
  it("窗口内多个 text_delta 合并成一帧，文本按序拼接", async () => {
    const out: ServerEvent[] = [];
    const t = new EventThrottle((_sid, e) => out.push(e), 20);
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "你" });
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "好" });
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "世界" });
    assert.equal(out.length, 0, "窗口未到时不该发帧（这正是节流的意义）");
    await sleep(60);
    assert.equal(out.length, 1, `应合并成 1 帧，实际 ${out.length}`);
    assert.deepEqual(out[0], { type: "text_delta", messageId: "m1", delta: "你好世界" });
  });

  it("生命周期事件即时冲刷：delta 绝不越过 message_end（保序硬约束）", () => {
    const out: ServerEvent[] = [];
    const t = new EventThrottle((_sid, e) => out.push(e), 5000); // 窗口很长，靠冲刷保证顺序
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "半句" });
    t.push("s1", {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1, text: "半句话", toolCalls: [] },
    });
    assert.equal(out.length, 2, "message_end 必须立即带出前面的 delta");
    assert.equal(out[0].type, "text_delta");
    assert.equal(out[1].type, "message_end");
  });

  it("不同 messageId 的 delta 不互相吞并", async () => {
    const out: ServerEvent[] = [];
    const t = new EventThrottle((_sid, e) => out.push(e), 20);
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "A" });
    t.push("s1", { type: "text_delta", messageId: "m2", delta: "B" });
    t.push("s1", { type: "thinking_delta", messageId: "m1", delta: "C" });
    await sleep(60);
    assert.equal(out.length, 3, "相邻不同 (type,messageId) 各自成帧");
    assert.deepEqual(
      out.map((e) => [e.type, (e as { messageId: string }).messageId]),
      [["text_delta", "m1"], ["text_delta", "m2"], ["thinking_delta", "m1"]],
    );
  });

  it("flushAll 清空全部会话缓冲（进程退出/实例逐出前不丢尾巴）", () => {
    const out: Array<[string, ServerEvent]> = [];
    const t = new EventThrottle((sid, e) => out.push([sid, e]), 5000);
    t.push("s1", { type: "text_delta", messageId: "m1", delta: "尾1" });
    t.push("s2", { type: "text_delta", messageId: "m2", delta: "尾2" });
    assert.equal(t.hasPending("s1"), true);
    t.flushAll();
    assert.equal(out.length, 2);
    assert.equal(t.hasPending("s1"), false);
    assert.equal(t.hasPending("s2"), false);
  });

  it("coalesceDeltas 纯函数：非 delta 事件原样保留", () => {
    const status: ServerEvent = { type: "status", status: "running" };
    const merged = coalesceDeltas([
      { type: "text_delta", messageId: "m", delta: "a" },
      status,
      { type: "text_delta", messageId: "m", delta: "b" },
    ]);
    assert.equal(merged.length, 3, "被 status 隔开，两段 delta 不能合并");
    assert.deepEqual(merged[1], status);
  });
});

describe("WS 背压判定（纯函数）", () => {
  const delta: ServerEvent = { type: "text_delta", messageId: "m1", delta: "x" };
  const settled: ServerEvent = { type: "agent_settled" };

  it("delta 可丢；超阈才丢", () => {
    assert.equal(isDroppableEvent(delta), true);
    assert.equal(isDroppableEvent({ type: "thinking_delta", messageId: "m", delta: "x" }), true);
    assert.equal(shouldDropUnderBackpressure(delta, WS_BACKPRESSURE_BYTES + 1), true);
    assert.equal(shouldDropUnderBackpressure(delta, WS_BACKPRESSURE_BYTES), false, "等于阈值不丢（> 才丢）");
    assert.equal(shouldDropUnderBackpressure(delta, 0), false);
  });

  it("生命周期事件永不丢：丢了 UI 会永久停在「思考中」", () => {
    for (const event of [
      settled,
      { type: "status", status: "running" } as ServerEvent,
      { type: "error", code: "X", message: "y" } as ServerEvent,
      {
        type: "message_end",
        message: { id: "m", role: "assistant", timestamp: 1, text: "t", toolCalls: [] },
      } as ServerEvent,
    ]) {
      assert.equal(isDroppableEvent(event), false);
      assert.equal(shouldDropUnderBackpressure(event, WS_BACKPRESSURE_BYTES * 100), false);
    }
  });

  it("阈值可注入（测试/调参用）", () => {
    assert.equal(shouldDropUnderBackpressure(delta, 10, 5), true);
    assert.equal(shouldDropUnderBackpressure(delta, 3, 5), false);
  });
});

describe("SessionHub parallel 路径：SDK delta 经节流合并后才广播", () => {
  let dir: string;
  const events: ServerEvent[] = [];
  const enc = "--tmp-throttle-demo--";

  interface Fake {
    session: AgentSession;
    emit: (event: AgentSessionEvent) => void;
  }
  function makeFake(): Fake {
    let handler: ((event: AgentSessionEvent) => void) | null = null;
    const session = {
      subscribe: (fn: (event: AgentSessionEvent) => void) => {
        handler = fn;
        return () => {
          handler = null;
        };
      },
      isIdle: true,
      prompt: async () => undefined,
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      compact: async () => undefined,
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;
    return { session, emit: (event) => handler?.(event) };
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-throttle-"));
    await mkdir(join(dir, enc), { recursive: true });
    const file = join(dir, enc, "t1.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "t1", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/throttle-demo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "历史消息", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
    // mtime 推回过去：表达「历史不活跃会话」，否则命中外部活跃闸门（见 hub-external-gate.test.ts）
    const aged = new Date(Date.now() - 10 * 60_000);
    await utimes(file, aged, aged);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("连续 token delta 合并成远少于 chunk 数的帧，且 message_end 不被延迟", async () => {
    events.length = 0;
    const fake = makeFake();
    const hub = new SessionHub(dir, (_id, event) => events.push(event), {
      createAgentSession: (async () => ({ session: fake.session })) as unknown as typeof createAgentSession,
      throttleMs: 20,
    });
    await hub.ensureLive("t1");
    events.length = 0;

    // 模拟一轮流式输出：message_start → 30 个 token delta → message_end
    fake.emit({ type: "message_start", message: { role: "assistant", timestamp: 1 } } as AgentSessionEvent);
    for (let i = 0; i < 30; i += 1) {
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `t${i}` },
      } as unknown as AgentSessionEvent);
    }
    fake.emit({
      type: "message_end",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "完整回答" }] },
    } as unknown as AgentSessionEvent);

    const deltas = events.filter((e) => e.type === "text_delta");
    assert.ok(deltas.length > 0, "delta 应有广播");
    assert.ok(deltas.length < 30, `30 个 chunk 应被合并（实际 ${deltas.length} 帧）`);
    // message_end 是生命周期事件：必须即时冲刷，且排在所有 delta 之后
    const endIdx = events.findIndex((e) => e.type === "message_end");
    assert.ok(endIdx > 0, "message_end 不该被节流延迟到窗口之后");
    assert.equal(events.filter((e) => e.type === "text_delta").every((_e, i) => i < endIdx), true);
    // 合并后文本无丢失
    const joined = deltas.map((e) => (e as { delta: string }).delta).join("");
    assert.equal(joined, Array.from({ length: 30 }, (_v, i) => `t${i}`).join(""));
    hub.disposeAll();
  });
});
