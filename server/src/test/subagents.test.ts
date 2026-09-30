/**
 * 子代理活动聚合（反馈轮 3 #4）：
 * buildSubAgentActivity 快照推导 / activityEventFrom 增量提取 / SubAgentRouter 血缘路由。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { activityEventFrom, buildSubAgentActivity, SubAgentRouter, truncateSummary } from "../subagents.js";
import type { MessageDto, ServerEvent, SessionListItem } from "../types.js";

const parent: SessionListItem = {
  id: "parent-1",
  source: "pi",
  name: "主会话",
  cwd: "/tmp/ws",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 3,
  status: "running",
  lastUserMessage: "派两个子代理",
  lastAssistantMessage: "好的",
  sessionFile: "/tmp/parent.jsonl",
  isSubAgent: false,
  parentSessionId: null,
};

const child = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  ...parent,
  id: "sub-1",
  name: "developer#abc123",
  isSubAgent: true,
  parentSessionId: "parent-1",
  status: "running",
  lastAssistantMessage: null,
  updatedAt: "2026-02-18T12:01:00.000Z",
  ...over,
});

const message = (over: Partial<MessageDto> = {}): MessageDto => ({
  id: "m1",
  role: "assistant",
  timestamp: 1000,
  text: "",
  toolCalls: [],
  ...over,
});

describe("buildSubAgentActivity", () => {
  it("从消息推导：运行中工具 + 最新输出 + 启动时间", () => {
    const messages: MessageDto[] = [
      message({ id: "u1", role: "user", timestamp: 900, text: "任务" }),
      message({
        id: "a1",
        timestamp: 1000,
        text: "正在分析根因",
        toolCalls: [{ name: "bash", summary: "grep -n foo src/", status: "running", resultPreview: null }],
      }),
    ];
    const act = buildSubAgentActivity(child(), messages);
    assert.equal(act.sessionId, "sub-1");
    assert.equal(act.name, "developer#abc123");
    assert.equal(act.currentTool, "grep -n foo src/");
    assert.equal(act.toolRunning, true);
    assert.equal(act.lastOutput, "正在分析根因");
    assert.equal(act.startedAt, 900);
    assert.equal(act.done, false);
    assert.equal(act.resultSummary, null);
  });

  it("idle 且有输出 = done，结果摘要取最后 assistant 文本", () => {
    const messages: MessageDto[] = [
      message({ id: "a1", timestamp: 1000, text: "早期输出" }),
      message({ id: "a2", timestamp: 2000, text: "完成：修复了 X" }),
    ];
    const act = buildSubAgentActivity(child({ status: "idle" }), messages);
    assert.equal(act.done, true);
    assert.equal(act.resultSummary, "完成：修复了 X");
    assert.equal(act.lastOutput, "完成：修复了 X");
  });

  it("无消息子代理：空摘要、startedAt null（时长从 0:00 起）", () => {
    const act = buildSubAgentActivity(child({ lastAssistantMessage: null }), []);
    assert.equal(act.currentTool, null);
    assert.equal(act.lastOutput, null);
    assert.equal(act.startedAt, null);
    assert.equal(act.done, false);
  });
});

describe("activityEventFrom", () => {
  it("tool_start/tool_end 带工具摘要（running 标志翻转）", () => {
    const start = activityEventFrom("sub-1", {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "bash", summary: "pnpm test" },
    });
    assert.deepEqual(start, {
      sessionId: "sub-1",
      currentTool: "pnpm test",
      toolRunning: true,
      updatedAt: start!.updatedAt,
    });
    const end = activityEventFrom("sub-1", {
      type: "tool_end",
      messageId: "m1",
      toolCall: { name: "bash", summary: "pnpm test", status: "done", resultPreview: null },
    });
    assert.equal(end?.toolRunning, false);
    assert.equal(end?.currentTool, "pnpm test");
  });

  it("message_end 只取 assistant 非空文本（user 消息/空消息不打扰面板）", () => {
    const hit = activityEventFrom("sub-1", {
      type: "message_end",
      message: { id: "m2", role: "assistant", timestamp: 3000, text: "最新输出", toolCalls: [] },
    });
    assert.equal(hit?.lastOutput, "最新输出");
    const userMsg = activityEventFrom("sub-1", {
      type: "message_end",
      message: { id: "m3", role: "user", timestamp: 3000, text: "用户消息", toolCalls: [] },
    });
    assert.equal(userMsg, null);
    const emptyMsg = activityEventFrom("sub-1", {
      type: "message_end",
      message: { id: "m4", role: "assistant", timestamp: 3000, text: "  ", toolCalls: [] },
    });
    assert.equal(emptyMsg, null);
  });

  it("status/agent_settled 收尾置 done；delta 不推送（动画克制）", () => {
    assert.deepEqual(activityEventFrom("sub-1", { type: "status", status: "idle" })?.done, true);
    assert.equal(activityEventFrom("sub-1", { type: "agent_settled" })?.done, true);
    assert.equal(activityEventFrom("sub-1", { type: "status", status: "running" })?.done, false);
    assert.equal(activityEventFrom("sub-1", { type: "text_delta", messageId: "m1", delta: "x" }), null);
    assert.equal(activityEventFrom("sub-1", { type: "thinking_delta", messageId: "m1", delta: "x" }), null);
  });
});

describe("truncateSummary", () => {
  it("截断长文本、空文本归 null", () => {
    const long = "x".repeat(200);
    const cut = truncateSummary(long);
    assert.equal(cut?.length, 161);
    assert.ok(cut?.endsWith("…"));
    assert.equal(truncateSummary("   "), null);
    assert.equal(truncateSummary(null), null);
    assert.equal(truncateSummary("短"), "短");
  });
});

describe("SubAgentRouter 血缘路由", () => {
  it("已知血缘：子会话事件转 subagent_activity 推给父通道（增量自带子代理名）", () => {
    const router = new SubAgentRouter(async () => child());
    router.remember("sub-1", "parent-1", "developer#abc123");
    const routed = router.route("sub-1", {
      type: "tool_end",
      messageId: "m1",
      toolCall: { name: "bash", summary: "pnpm test", status: "done", resultPreview: null },
    });
    assert.equal(routed?.parentSessionId, "parent-1");
    assert.equal(routed?.event.type, "subagent_activity");
    if (routed?.event.type === "subagent_activity") {
      assert.equal(routed.event.sessionId, "sub-1");
      assert.equal(routed.event.activity.currentTool, "pnpm test");
      assert.equal(routed.event.activity.name, "developer#abc123");
    }
  });

  it("非子代理/未知血缘：miss 异步补缓存，当次不路由（下一事件生效）", async () => {
    const router = new SubAgentRouter(async () => parent);
    assert.equal(
      router.route("parent-1", { type: "agent_settled" }),
      null,
    );
    // 等 miss 的异步解析落缓存（非子代理记为无父，不再路由）
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(router.route("parent-1", { type: "agent_settled" }), null);
  });

  it("miss 后解析到子代理血缘：后续事件路由到父通道", async () => {
    const router = new SubAgentRouter(async (id) => (id === "sub-1" ? child() : null));
    assert.equal(router.route("sub-1", { type: "agent_settled" }), null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const routed = router.route("sub-1", { type: "agent_settled" });
    assert.equal(routed?.parentSessionId, "parent-1");
  });

  it("delta 等非摘要事件不产出路由（动画克制）", () => {
    const router = new SubAgentRouter(async () => child());
    router.remember("sub-1", "parent-1");
    const ev: ServerEvent = { type: "text_delta", messageId: "m1", delta: "x" };
    assert.equal(router.route("sub-1", ev), null);
  });
});
