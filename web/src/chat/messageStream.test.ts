import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import { applyWsEvent } from "./messageStream";

const base = (): SessionMessage[] => [];

describe("applyWsEvent（WS 流式事件）", () => {
  it("message_start 建占位，text_delta 做打字机追加", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("");

    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "你好" });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "，世界" });
    expect(msgs[0].text).toBe("你好，世界");
  });

  it("message_end 用权威消息整体替换", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "中间态" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "最终权威文本", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("最终权威文本");
  });

  it("tool_start / tool_end 更新 toolCalls", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1 },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls -la" },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls -la", status: "done", resultPreview: "total 0" },
    });
    expect(msgs[0].toolCalls).toEqual([
      { name: "bash", summary: "ls -la", status: "done", resultPreview: "total 0" },
    ]);
  });

  it("未知事件与未知 messageId 不改变状态", () => {
    const msgs = base();
    expect(applyWsEvent(msgs, { type: "agent_settled" })).toBe(msgs);
    expect(applyWsEvent(msgs, { type: "text_delta", messageId: "nope", delta: "x" })).toBe(msgs);
    expect(applyWsEvent(msgs, { type: "thinking_delta", messageId: "nope", delta: "x" })).toBe(msgs);
  });
});

describe("thinking_delta 思维链累积", () => {
  it("thinking_delta 累积到消息 thinking 字段，与 text_delta 互不干扰", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "先想" });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "回答" });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "一下" });
    expect(msgs[0].thinking).toBe("先想一下");
    expect(msgs[0].text).toBe("回答");
  });

  it("message_end 带 thinking 时一并显示（整体替换）", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "流式思维" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", thinking: "权威思维链", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thinking).toBe("权威思维链");
    expect(msgs[0].text).toBe("正文");
  });

  it("message_end 未带 thinking 时保留流式累积的思维链（不被抹掉）", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "流式思维" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", toolCalls: [] },
    });
    expect(msgs[0].thinking).toBe("流式思维");
  });

  it("无思维链消息 thinking 为 null（MessageBubble 不渲染折叠块）", () => {
    const msgs = applyWsEvent(base(), {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", thinking: null, toolCalls: [] },
    });
    expect(msgs[0].thinking).toBeNull();
  });
});

describe("tool_start 合并 pending 工具卡（pi 真实时序：工具执行在 message_end 之后）", () => {
  it("message_end 已带 pending 工具卡时，tool_start/tool_end 更新同一张卡，不重复追加", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_end",
      message: {
        id: "live-2",
        role: "assistant",
        timestamp: 1,
        text: "我要执行命令",
        thinking: null,
        toolCalls: [{ name: "bash", summary: "echo hi", status: "pending", resultPreview: null }],
      },
    });
    msgs = applyWsEvent(msgs, { type: "tool_start", messageId: "live-2", toolCall: { name: "bash", summary: "echo hi" } });
    expect(msgs[0].toolCalls).toHaveLength(1);
    expect(msgs[0].toolCalls[0].status).toBe("running");
    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "live-2",
      toolCall: { name: "bash", summary: "echo hi", status: "done", resultPreview: "hi" },
    });
    expect(msgs[0].toolCalls).toHaveLength(1);
    expect(msgs[0].toolCalls[0]).toEqual({ name: "bash", summary: "echo hi", status: "done", resultPreview: "hi" });
  });

  it("没有同名 pending 卡时 tool_start 照旧追加新卡", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1 },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls" },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "read", summary: "a.txt" },
    });
    expect(msgs[0].toolCalls).toHaveLength(2);
    expect(msgs[0].toolCalls.map((t) => t.name)).toEqual(["bash", "read"]);
  });
});

describe("message_end 内容级去重兜底（重复气泡防御）", () => {
  it("不同 id 但同 role+同 text 且时间接近时合并为一条，保留权威 id", () => {
    // 流式占位（旧 bug：占位 id 与权威 id 不一致）
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "stream-1", role: "assistant", timestamp: 1_000 },
    });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "stream-1", delta: "最终回复内容" });
    // 权威投递 id 不同但内容一致（时间接近）
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-9", role: "assistant", timestamp: 2_000, text: "最终回复内容", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("authoritative-9");
    expect(msgs[0].text).toBe("最终回复内容");
  });

  it("同 role+同 text 但时间相隔久远且不相邻时不去重（保留合法重复）", () => {
    const msgs: SessionMessage[] = [
      { id: "a", role: "user", timestamp: 0, text: "同样的内容", toolCalls: [] },
      { id: "b", role: "assistant", timestamp: 10, text: "占位", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "c", role: "user", timestamp: 3_600_000, text: "同样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(3);
    expect(next.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("相邻但 text 为空的多条消息不去重（工具卡占位安全）", () => {
    const msgs: SessionMessage[] = [
      { id: "a", role: "assistant", timestamp: 0, text: "", toolCalls: [{ name: "bash", summary: "x", status: "done", resultPreview: null }] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "b", role: "assistant", timestamp: 1, text: "", toolCalls: [] },
    });
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("同 role+同 text、时间接近、但中间隔有其它消息 → 不合并（占位形态 id）", () => {
    const msgs: SessionMessage[] = [
      { id: "live-1", role: "user", timestamp: 0, text: "同样的内容", toolCalls: [] },
      { id: "b", role: "assistant", timestamp: 5, text: "中间的回复", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-2", role: "user", timestamp: 10, text: "同样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(3);
    expect(next.map((m) => m.id)).toEqual(["live-1", "b", "authoritative-2"]);
  });

  it("相邻且占位形态 id 但 text 不同 → 不合并", () => {
    const msgs: SessionMessage[] = [
      { id: "live-9", role: "assistant", timestamp: 0, text: "第一版回复", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-3", role: "assistant", timestamp: 1, text: "不一样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id)).toEqual(["live-9", "authoritative-3"]);
  });

  it("user 乐观占位（local-）被权威消息回填，保留权威 id 且只留 1 条", () => {
    const msgs: SessionMessage[] = [
      { id: "local-17", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-user", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("authoritative-user");
    expect(next[0].text).toBe("hi");
  });
});
