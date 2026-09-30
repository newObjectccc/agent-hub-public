/**
 * 工具执行时长打点（tool_start/tool_end → startedAt/endedAt）与权威回填保留。
 */
import { describe, expect, it } from "vitest";
import { applyWsEvent, type WsEvent } from "./messageStream";

describe("messageStream 工具执行时长打点", () => {
  it("tool_start 记 startedAt（事件 timestamp）；tool_end 记 endedAt 并保留 startedAt", () => {
    let msgs = applyWsEvent([], { type: "message_start", message: { id: "a1", role: "assistant", timestamp: 1 } });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "a1",
      toolCall: { name: "bash", summary: "ls" },
      timestamp: 1000,
    });
    expect(msgs[0].toolCalls[0]).toMatchObject({ name: "bash", status: "running", startedAt: 1000 });

    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "a1",
      toolCall: { name: "bash", summary: "ls", status: "done" },
      timestamp: 4500,
    });
    expect(msgs[0].toolCalls[0]).toMatchObject({ status: "done", startedAt: 1000, endedAt: 4500 });
  });

  it("无 timestamp 的事件用本地时钟打点（startedAt/endedAt 为数字）", () => {
    let msgs = applyWsEvent([], { type: "message_start", message: { id: "a1", role: "assistant", timestamp: 1 } });
    msgs = applyWsEvent(msgs, { type: "tool_start", messageId: "a1", toolCall: { name: "read" } });
    expect(typeof msgs[0].toolCalls[0].startedAt).toBe("number");
  });

  it("message_end 权威回填保留前端打点（server DTO 不带 startedAt/endedAt）", () => {
    let msgs = applyWsEvent([], { type: "message_start", message: { id: "a1", role: "assistant", timestamp: 1 } });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "a1",
      toolCall: { name: "bash", summary: "ls" },
      timestamp: 1000,
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "a1",
      toolCall: { name: "bash", summary: "ls", status: "done" },
      timestamp: 3000,
    });
    const authoritative: WsEvent = {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        timestamp: 1,
        text: "完成",
        toolCalls: [{ name: "bash", summary: "ls", status: "done", resultPreview: "ok" }],
      },
    };
    msgs = applyWsEvent(msgs, authoritative);
    expect(msgs[0].toolCalls).toHaveLength(1);
    expect(msgs[0].toolCalls[0]).toMatchObject({ startedAt: 1000, endedAt: 3000, resultPreview: "ok" });
    expect(msgs[0].text).toBe("完成");
  });

  it("message_end 带 pending 卡 + tool_start 合并同名单卡并打点（不双卡）", () => {
    let msgs = applyWsEvent([], {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        timestamp: 1,
        text: "开始",
        toolCalls: [{ name: "bash", summary: "run", status: "pending", resultPreview: null }],
      },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "a1",
      toolCall: { name: "bash", summary: "run" },
      timestamp: 2000,
    });
    expect(msgs[0].toolCalls).toHaveLength(1);
    expect(msgs[0].toolCalls[0]).toMatchObject({ status: "running", startedAt: 2000 });
  });
});
