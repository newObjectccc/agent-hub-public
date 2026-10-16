/**
 * CodexStreamTranslator 单测（纯函数状态机）：
 * `codex exec --json` 事件流 → 契约 WS 事件映射（与 claude-stream.test.ts 同风格）。
 * fixture 形态按 2026-10-09 实测（thread.started / item.completed / turn.failed）+
 * 二进制 serde tag 表枚举（agent_message_content_delta 等）构造。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CodexStreamTranslator } from "../adapters/codex-stream.js";
import { JsonlReader } from "../adapters/jsonl-reader.js";
import type { ServerEvent } from "../types.js";

const row = (obj: Record<string, unknown>): string => JSON.stringify(obj);

function types(events: ServerEvent[]): string[] {
  return events.map((e) => e.type);
}

function feedAll(translator: CodexStreamTranslator, lines: string[]): ServerEvent[] {
  return lines.flatMap((line) => translator.feed(line));
}

describe("CodexStreamTranslator：消息流", () => {
  it("task_complete 单独携带最终答案时保留可见文本，已有全文时不重复气泡", () => {
    const onlyFinal = new CodexStreamTranslator().feed(row({ type: "task_complete", last_agent_message: "完成了" }));
    const end = onlyFinal.find((event) => event.type === "message_end");
    assert.equal(end?.type === "message_end" ? end.message.text : null, "完成了");
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "item.completed", item: { type: "agent_message", text: "完成了" } }),
      row({ type: "task_complete", last_agent_message: "完成了" }),
    ]);
    assert.equal(events.filter((event) => event.type === "message_end").length, 1);
  });

  it("task_complete 最终文本不会覆盖真实工具 owner", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "item.completed", item: { id: "command", type: "command_execution", command: "pwd" } }),
      row({ type: "task_complete", last_agent_message: "已完成" }),
    ]);
    const messages = events.filter((event): event is Extract<ServerEvent, { type: "message_end" }> => event.type === "message_end");
    assert.equal(messages.length, 2); assert.equal(messages[0].message.toolCalls.length, 1);
    assert.equal(messages[1].message.text, "已完成");
  });

  it("content_delta → message_start + text_delta；task_complete → message_end + idle + settled", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "thread.started", thread_id: "01a1" }),
      row({ type: "turn.started" }),
      row({ type: "agent_message_content_delta", item_id: "item_0", delta: "你好，" }),
      row({ type: "agent_message_content_delta", item_id: "item_0", delta: "我先看看代码。" }),
      row({ type: "task_complete", turn_id: "t1", last_agent_message: "你好，我先看看代码。" }),
    ]);
    assert.deepEqual(types(events), ["status", "status", "message_start", "text_delta", "text_delta", "message_end", "status", "agent_settled"]);
    const start = events[2] as Extract<ServerEvent, { type: "message_start" }>;
    assert.equal(start.message.role, "assistant");
    const end = events[5] as Extract<ServerEvent, { type: "message_end" }>;
    assert.equal(end.message.role, "assistant");
    assert.equal(end.message.text, "你好，我先看看代码。");
    assert.equal(t.finished, true);
  });

  it("agent_message 全文事件收尾 message_end（无 delta 的版本）", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "turn.started" }),
      row({ type: "agent_message", message: "已生成新的 Prisma Client。" }),
      row({ type: "turn.completed" }),
    ]);
    assert.deepEqual(types(events), ["status", "message_start", "message_end", "status", "agent_settled"]);
    const end = events[2] as Extract<ServerEvent, { type: "message_end" }>;
    assert.equal(end.message.text, "已生成新的 Prisma Client。");
  });

  it("item.completed(agent_message) 权威全文收尾；user_message 回显跳过（适配层已合成）", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "turn.started" }),
      row({ type: "user_message", message: "帮我看看", images: [], local_images: [], text_elements: [] }),
      row({ type: "item.started", item: { id: "item_1", type: "agent_message" } }),
      row({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "好的，" } }),
      row({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "好的，我先复现。" } }),
      row({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", content: [{ type: "output_text", text: "好的，我先复现。" }], phase: "final_answer" },
      }),
      row({ type: "task_complete", turn_id: "t1" }),
    ]);
    assert.deepEqual(types(events), ["status", "message_start", "text_delta", "text_delta", "message_end", "status", "agent_settled"]);
    const end = events[4] as Extract<ServerEvent, { type: "message_end" }>;
    assert.equal(end.message.text, "好的，我先复现。");
  });
});

describe("CodexStreamTranslator：工具条目", () => {
  it("item.started + item.completed(command_execution) → tool_start + tool_end（结果折叠回消息）", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "turn.started" }),
      row({ type: "agent_message", message: "我先搜一下" }),
      row({
        type: "item.started",
        item: { id: "item_2", type: "command_execution", command: "rg -n foo .", status: "in_progress" },
      }),
      row({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "rg -n foo .",
          aggregated_output: "./a.ts:1:foo",
          exit_code: 0,
          status: "completed",
        },
      }),
      row({ type: "task_complete", turn_id: "t1" }),
    ]);
    assert.deepEqual(types(events), [
      "status",
      "message_start",
      "tool_start",
      "tool_end",
      "message_end",
      "status",
      "agent_settled",
    ]);
    const toolStart = events[2] as Extract<ServerEvent, { type: "tool_start" }>;
    assert.equal(toolStart.toolCall.name, "exec_command");
    assert.equal(toolStart.toolCall.summary, "rg -n foo .");
    const toolEnd = events[3] as Extract<ServerEvent, { type: "tool_end" }>;
    assert.equal(toolEnd.toolCall.status, "done");
    assert.equal(toolEnd.toolCall.resultPreview, "./a.ts:1:foo");
    const end = events[4] as Extract<ServerEvent, { type: "message_end" }>;
    assert.equal(end.message.toolCalls.length, 1);
    assert.equal(end.message.toolCalls[0].status, "done");
  });

  it("无 item.started 直接 completed：tool_start + tool_end 一次补齐；exit_code 非 0 → error", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "turn.started" }),
      row({
        type: "item.completed",
        item: { id: "item_3", type: "command_execution", command: "npm test", aggregated_output: "boom", exit_code: 1, status: "failed" },
      }),
      row({ type: "task_complete", turn_id: "t1" }),
    ]);
    assert.deepEqual(types(events), ["status", "message_start", "tool_start", "tool_end", "message_end", "status", "agent_settled"]);
    const toolEnd = events[3] as Extract<ServerEvent, { type: "tool_end" }>;
    assert.equal(toolEnd.toolCall.status, "error");
    assert.equal(toolEnd.toolCall.resultPreview, "boom");
  });

  it("item.started 不重复开工具；未知/无害条目（reasoning/error 等）跳过", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "turn.started" }),
      row({ type: "item.started", item: { id: "item_4", type: "command_execution", command: "ls" } }),
      row({ type: "item.started", item: { id: "item_4", type: "command_execution", command: "ls" } }),
      row({ type: "item.completed", item: { id: "item_5", type: "reasoning", summary: [] } }),
      row({ type: "item.completed", item: { id: "item_6", type: "error", message: "warning: …" } }),
      row({ type: "item.completed", item: { id: "item_4", type: "command_execution", command: "ls", aggregated_output: "a.ts", exit_code: 0 } }),
      row({ type: "task_complete", turn_id: "t1" }),
    ]);
    assert.deepEqual(types(events), ["status", "message_start", "tool_start", "tool_end", "message_end", "status", "agent_settled"]);
  });
});

describe("CodexStreamTranslator：终态与容错", () => {
  it("空 agent/plan 占位不发气泡，后续真实工具和最终文本仍然保留", () => {
    const t = new CodexStreamTranslator();
    const empty = feedAll(t, [
      row({ type: "item.started", item: { id: "empty", type: "agent_message" } }),
      row({ type: "item.completed", item: { id: "empty", type: "agent_message", text: "" } }),
      row({ type: "item.completed", item: { id: "plan", type: "reasoning", summary: [] } }),
    ]);
    assert.deepEqual(empty, []);
    const events = feedAll(t, [
      row({ type: "item.completed", item: { id: "tool", type: "mcp_tool_call", tool: "list_issues", server: "linear" } }),
      row({ type: "item.started", item: { id: "final", type: "agent_message" } }),
      row({ type: "item.completed", item: { id: "final", type: "agent_message", text: "已完成" } }),
      row({ type: "turn.completed" }),
    ]);
    const messages = events.filter((event): event is Extract<ServerEvent, { type: "message_end" }> => event.type === "message_end");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.text, "");
    assert.equal(messages[0].message.toolCalls[0].name, "list_issues");
    assert.equal(messages[1].message.text, "已完成");
    assert.deepEqual(t.feed(row({ type: "turn.started" })), []);
    assert.deepEqual(t.feed(row({ type: "turn.completed" })), []);
  });

  it("error + turn.failed 只发一条 error；status error + settled", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      row({ type: "thread.started", thread_id: "01a1" }),
      row({ type: "turn.started" }),
      row({ type: "error", message: "model not supported" }),
      row({ type: "turn.failed", error: { message: "model not supported" } }),
    ]);
    assert.deepEqual(types(events), ["status", "status", "error", "status", "agent_settled"]);
    assert.equal(t.finished, true);
  });

  it("非 JSON 行 / 未知 type / 坏 JSON 优雅跳过；flush 兜底收尾未竟消息", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [
      "[codex:some notice]",
      "not json at all",
      row({ type: "token_count", usage: {} }),
      row({ type: "agent_message_content_delta", delta: "写到一半" }),
    ]);
    assert.deepEqual(types(events), ["message_start", "text_delta"]);
    const flushed = t.flush();
    assert.deepEqual(types(flushed), ["message_end"]);
    assert.equal((flushed[0] as Extract<ServerEvent, { type: "message_end" }>).message.text, "写到一半");
    // 已收尾：重复 flush 不再发
    assert.deepEqual(t.flush(), []);
    assert.equal(t.finished, false); // 未见轮终态
  });

  it("turn_aborted 视为 idle 收尾（用户中止，UI 恢复可输入）", () => {
    const t = new CodexStreamTranslator();
    const events = feedAll(t, [row({ type: "turn.started" }), row({ type: "turn_aborted", turn_id: "t1" })]);
    assert.deepEqual(types(events), ["status", "status", "agent_settled"]);
    assert.equal(t.finished, true);
  });
});

it("Codex JSONL reader 跨 UTF-8 分块、无换行尾行与重复 end 均不丢不重", () => {
  const lines: string[] = [];
  const reader = new JsonlReader((line) => lines.push(line));
  const bytes = Buffer.from('你好\n世界');
  for (const byte of bytes) reader.write(Buffer.from([byte]));
  reader.end(); reader.end(); reader.write('ignored');
  assert.deepEqual(lines, ['你好', '世界']);
});
