/**
 * claude stream-json → 契约 WS 事件映射单测（fixture 取自 claude 2.1.267 实测输出脱敏）。
 * 覆盖：status running、message_start/text_delta、tool_start/tool_end、message_end、
 * agent_settled、错误 result、未知/非 JSON 行跳过、无 result 崩溃时 flush 兜底。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ClaudeStreamTranslator } from "../adapters/claude-stream.js";
import type { ServerEvent } from "../types.js";

function feedAll(translator: ClaudeStreamTranslator, lines: string[]): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const line of lines) events.push(...translator.feed(line));
  return events;
}

function types(events: ServerEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("claude stream: 文本轮映射", () => {
  it("init → status running；text_delta → message_end → result → idle + agent_settled", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sid", cwd: "/tmp/demo" }),
      JSON.stringify({ type: "system", subtype: "status", status: {} }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_A", role: "assistant", content: [] } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "命令" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "输出为 `hi`。" } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_A", role: "assistant", content: [{ type: "text", text: "命令输出为 `hi`。" }] },
        uuid: "a1",
        timestamp: "2026-09-29T12:08:05.935Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop" } }),
      JSON.stringify({ type: "stream_event", event: { type: "message_delta", stop_reason: "end_turn" } }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "命令输出为 `hi`。", session_id: "sid" }),
    ]);

    assert.deepEqual(types(events), [
      "status", // running
      "message_start",
      "text_delta",
      "text_delta",
      "message_end",
      "status", // idle
      "agent_settled",
    ]);
    assert.equal((events[0] as { status: string }).status, "running");
    const start = events[1] as { message: { id: string; role: string } };
    assert.equal(start.message.role, "assistant");
    const messageId = start.message.id;
    assert.equal((events[2] as { messageId: string }).messageId, messageId);
    assert.equal((events[2] as { delta: string }).delta, "命令");
    const end = events.find((e) => e.type === "message_end") as { message: { id: string; text: string; role: string } };
    assert.equal(end.message.id, messageId); // 流式占位与权威消息同 id（前端 upsert 不出重复气泡）
    assert.equal(end.message.role, "assistant");
    assert.equal(end.message.text, "命令输出为 `hi`。");
    assert.equal(t.finished, true);
  });
});

describe("claude stream: 工具调用轮映射", () => {
  it("tool_use → tool_start；tool_result → tool_end（status/preview 回填）；thinking 跳过", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_B", role: "assistant", content: [] } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_B", role: "assistant", content: [{ type: "thinking", thinking: "跑一下命令" }] },
        uuid: "a2",
        timestamp: "2026-09-29T12:08:06.000Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "call_1", name: "Bash", input: {} } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"command\": \"echo hi\"}" } } }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_B",
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo hi" } }],
        },
        uuid: "a3",
        timestamp: "2026-09-29T12:08:06.500Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ tool_use_id: "call_1", type: "tool_result", content: "hi", is_error: false }] },
        uuid: "u1",
        timestamp: "2026-09-29T12:08:07.000Z",
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: "sid" }),
    ]);

    assert.deepEqual(types(events), [
      "message_start",
      "tool_start",
      "message_end",
      "tool_end",
      "status",
      "agent_settled",
    ]);
    const start = events[0] as { message: { id: string } };
    const toolStart = events[1] as { messageId: string; toolCall: { name: string; summary: string } };
    assert.equal(toolStart.messageId, start.message.id);
    assert.equal(toolStart.toolCall.name, "Bash");
    assert.equal(toolStart.toolCall.summary, "echo hi");
    const end = events.find((e) => e.type === "message_end") as {
      message: { text: string; toolCalls: Array<{ name: string; status: string; resultPreview: string | null }> };
    };
    assert.equal(end.message.text, ""); // thinking 不进 chat
    assert.equal(end.message.toolCalls.length, 1);
    assert.equal(end.message.toolCalls[0].status, "running"); // message_stop 时尚无结果
    const toolEnd = events.find((e) => e.type === "tool_end") as {
      messageId: string;
      toolCall: { name: string; status: string; resultPreview: string | null };
    };
    assert.equal(toolEnd.messageId, start.message.id); // 折叠进同一条 assistant 消息
    assert.equal(toolEnd.toolCall.status, "done");
    assert.equal(toolEnd.toolCall.resultPreview, "hi");
  });
});

describe("claude stream: 容错与异常", () => {
  it("未知 type、非 JSON 行、未知 delta 类型优雅跳过不崩", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      "[claude-code:unrecognized_model] {\"model\":\"x\"}",
      "",
      "   ",
      JSON.stringify({ type: "totally-unknown", foo: 1 }),
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "" } } }),
      JSON.stringify({ notAType: true }),
    ]);
    assert.deepEqual(events, []);
  });

  it("result is_error → error 事件 + status error + agent_settled", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_C", role: "assistant", content: [] } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_C", role: "assistant", content: [{ type: "text", text: "部分输出" }] },
        uuid: "a4",
        timestamp: "2026-09-29T12:09:00.000Z",
      }),
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API error", session_id: "sid" }),
    ]);
    assert.deepEqual(types(events), ["message_start", "message_end", "error", "status", "agent_settled"]);
    const err = events.find((e) => e.type === "error") as { code: string; message: string };
    assert.equal(err.code, "PROMPT_FAILED");
    assert.match(err.message, /API error/);
    assert.equal((events.find((e) => e.type === "status") as { status: string }).status, "error");
  });

  it("无 result（进程崩溃）时 flush 兜底未竟消息", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_D", role: "assistant", content: [] } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_D", role: "assistant", content: [{ type: "text", text: "写到一半" }] },
        uuid: "a5",
        timestamp: "2026-09-29T12:10:00.000Z",
      }),
    ]);
    assert.deepEqual(types(events), ["message_start"]);
    const flushed = t.flush();
    assert.deepEqual(types(flushed), ["message_end"]);
    assert.equal((flushed[0] as { message: { text: string } }).message.text, "写到一半");
    assert.equal(t.finished, false);
  });

  it("API 消息切换（多段 tool_use → text）时按 message.id 分段 message_end", () => {
    const t = new ClaudeStreamTranslator();
    const events = feedAll(t, [
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_E1", role: "assistant", content: [] } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_E1", role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "Read", input: { path: "/tmp/a" } }] },
        uuid: "a6",
        timestamp: "2026-09-29T12:11:00.000Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ tool_use_id: "call_9", type: "tool_result", content: "file content", is_error: false }] },
        uuid: "u2",
        timestamp: "2026-09-29T12:11:01.000Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_E2", role: "assistant", content: [] } } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_E2", role: "assistant", content: [{ type: "text", text: "看完了" }] },
        uuid: "a7",
        timestamp: "2026-09-29T12:11:02.000Z",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "看完了", session_id: "sid" }),
    ]);
    const ends = events.filter((e) => e.type === "message_end") as Array<{ message: { id: string; text: string } }>;
    assert.equal(ends.length, 2);
    assert.notEqual(ends[0].message.id, ends[1].message.id);
    assert.equal(ends[1].message.text, "看完了");
    // tool_end 必须挂在第一段消息的 id 上
    const toolEnd = events.find((e) => e.type === "tool_end") as { messageId: string };
    const start1 = events[0] as { message: { id: string } };
    assert.equal(toolEnd.messageId, start1.message.id);
  });
});
