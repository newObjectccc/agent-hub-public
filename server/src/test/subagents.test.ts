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

describe("首波事件缓存 flush（AC7 缺陷 A 回归）", () => {
  it("血缘未解析期间的事件不丢：resolve 后 onDrain 按序补投", async () => {
    const drained: Array<{ parentSessionId: string }> = [];
    const router = new SubAgentRouter(
      async (id) =>
        id === "child-1"
          ? { id, parentSessionId: "parent-1", name: "developer#abc", isSubAgent: true } as never
          : null,
      (routed) => drained.push(routed),
    );
    // 首波（血缘未知）：route 返回 null 但事件被缓存
    const first = router.route("child-1", {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1, text: "第一条输出", toolCalls: [] },
    } as never);
    assert.equal(first, null);
    // 等 resolve + flush
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(drained.length >= 1, `首波应补投，实际 ${drained.length}`);
    assert.equal(drained[0].parentSessionId, "parent-1");
    // 血缘已缓存：后续事件直接路由
    const second = router.route("child-1", {
      type: "message_end",
      message: { id: "m2", role: "assistant", timestamp: 2, text: "第二条", toolCalls: [] },
    } as never);
    assert.equal(second?.parentSessionId, "parent-1");
  });

  it("remember() 预热后 route 首事件即达（无 miss）", () => {
    const router = new SubAgentRouter(async () => null);
    router.remember("child-2", "parent-2", "acceptance-reviewer#xyz");
    const routed = router.route("child-2", {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1, text: "hi", toolCalls: [] },
    } as never);
    assert.equal(routed?.parentSessionId, "parent-2");
  });
});

describe("轻量血缘扫描：静态子会话文件必现（AC2 回归）", () => {
  it("新写入的静态子会话（写完即静止）立即可被 scanSubAgentLineage 发现", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scanSubAgentLineage } = await import("../sessions/scan.js");
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-lineage-"));
    try {
      // 静态文件：一次写入后不再变化（用户实测"永不出"的场景）。
      // parentSession 用**真实 pi 格式**（父会话文件路径，48/48 真实样本同款），非裸 id
      await writeFile(
        join(dir, "child.jsonl"),
        [
          JSON.stringify({ type: "session", version: 3, id: "child-x", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x", parentSession: "--Users-me--sessions/2026-01-01T00-00-00-000Z_parent-x.jsonl" }),
          JSON.stringify({ type: "session_info", name: "developer#deadbeef", timestamp: "2026-01-01T00:00:00.000Z" }),
          JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "task" } }),
        ].join("\n"),
        "utf8",
      );
      const lineage = await scanSubAgentLineage(dir);
      const hit = lineage.find((l) => l.id === "child-x");
      assert.ok(hit, "静态子会话应被发现");
      assert.equal(hit.parentSessionId, "parent-x", "路径形态应归一化为父会话 id");
      assert.equal(hit.name, "developer#deadbeef");
      // 端到端：listChildren(父 id) 命中（registry 比对口径）
      const { SessionRegistry } = await import("../adapters/registry.js");
      const fakeAdapter = { source: "pi", isLive: () => false, getStatus: () => "idle", listSessions: async () => [], findSession: async () => null, loadMessages: async () => null, prompt: async () => ({ accepted: true, mode: "prompt" }), abort: async () => undefined, disposeAll: () => undefined } as never;
      const registry = new SessionRegistry(fakeAdapter, fakeAdapter, dir);
      const kids = await registry.listChildren("parent-x");
      assert.ok(kids.some((k) => k.id === "child-x"), "listChildren 应命中真实路径格式的子会话");
      // 裸 id 兼容格式同样命中
      await writeFile(
        join(dir, "child2.jsonl"),
        [
          JSON.stringify({ type: "session", version: 3, id: "child-y", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x", parentSession: "parent-x" }),
          JSON.stringify({ type: "session_info", name: "acceptance-reviewer#cafe01", timestamp: "2026-01-01T00:00:00.000Z" }),
        ].join("\n"),
        "utf8",
      );
      const kids2 = await registry.listChildren("parent-x");
      assert.ok(kids2.some((k) => k.id === "child-y"), "裸 id 兼容格式也应命中");
      // fork 口径：带 parentSession 但无子代理命名 → 不收（有 name 时以命名为准）
      await writeFile(
        join(dir, "fork.jsonl"),
        [
          JSON.stringify({ type: "session", version: 3, id: "fork-z", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x", parentSession: "parent-x" }),
          JSON.stringify({ type: "session_info", name: "我的分叉会话", timestamp: "2026-01-01T00:00:00.000Z" }),
        ].join("\n"),
        "utf8",
      );
      const kids3 = await registry.listChildren("parent-x");
      assert.ok(!kids3.some((k) => k.id === "fork-z"), "fork（有名字但非子代理命名）不应收");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E3 阻断缺陷回归（REV-E3）", () => {
  it("未 attach 时长轮询挂起不热转（返回前至少等待 waitMs）", async () => {
    const { AgentCommandHub } = await import("../agents.js");
    const hub = new AgentCommandHub();
    const t0 = Date.now();
    const out = await hub.poll("no-such-session", 300);
    const elapsed = Date.now() - t0;
    assert.deepEqual(out, []);
    assert.ok(elapsed >= 280, `未 attach 应挂起等待（实测 ${elapsed}ms），防热空转`);
  });

  it("clientMessageId 幂等跨指令完成仍有效（重复提交不二次注入）", async () => {
    const { AgentCommandHub } = await import("../agents.js");
    const hub = new AgentCommandHub();
    hub.heartbeat({ sessionId: "sess-x", pid: 1, cwd: "/tmp", capabilities: ["attach"] });
    hub.attach("sess-x");
    const first = hub.enqueue("sess-x", { kind: "message", text: "hi", mode: "prompt", clientMessageId: "cm-1" } as never);
    // 指令完成（ack）
    hub.ack("sess-x", first.id, true);
    // 重复提交同 clientMessageId：不得生成新指令（防二次注入）
    const second = hub.enqueue("sess-x", { kind: "message", text: "hi", mode: "prompt", clientMessageId: "cm-1" } as never);
    assert.equal(second.id, first.id, "重复提交应幂等返回既有指令");
  });
});
