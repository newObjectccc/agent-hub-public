/**
 * claude Task 子代理（sidechain）解析与面板聚合测试：
 * - Task tool_use 开记录、tool_result 关记录（含 is_error）
 * - sidechain 行归属子代理记录且不污染主消息流
 * - 运行态：当前工具 / toolRunning / lastOutput
 * - buildClaudeSubAgentActivity 映射口径（名称、状态、截断）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeTranscript } from "../adapters/claude-transcript.js";
import { buildClaudeSubAgentActivity } from "../subagents.js";

const row = (obj: Record<string, unknown>): string => JSON.stringify(obj);

function transcript(lines: Record<string, unknown>[]): string {
  return lines.map(row).join("\n");
}

describe("parseClaudeTranscript: Task 子代理（sidechain）", () => {
  it("Task tool_use 开启记录，sidechain 行归属它，tool_result 关闭并带结果摘要", () => {
    const content = transcript([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-10-08T10:00:00.000Z",
        message: { role: "user", content: "帮我调研一下" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-08T10:00:05.000Z",
        message: {
          role: "assistant",
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "toolu_abc12345",
              name: "Task",
              input: { description: "调研 web 组件", subagent_type: "Explore", prompt: "列出组件" },
            },
          ],
        },
      },
      // sidechain：子代理自己的工具调用与输出
      {
        type: "assistant",
        uuid: "sa1",
        isSidechain: true,
        timestamp: "2026-10-08T10:00:10.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "inner1", name: "Grep", input: { pattern: "export function" } },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "sa2",
        isSidechain: true,
        timestamp: "2026-10-08T10:00:12.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "找到了 20 个组件" }] },
      },
      // 主线：Task 的 tool_result（完成）
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-10-08T10:00:20.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc12345",
              content: "共 20 个组件，详见清单",
            },
          ],
        },
      },
    ]);

    const parsed = parseClaudeTranscript(content);
    assert.equal(parsed.subAgents.length, 1);
    const sub = parsed.subAgents[0];
    assert.equal(sub.id, "toolu_abc12345");
    assert.equal(sub.type, "Explore");
    assert.equal(sub.description, "调研 web 组件");
    assert.equal(sub.done, true);
    assert.equal(sub.error, false);
    assert.equal(sub.resultSummary, "共 20 个组件，详见清单");
    assert.equal(sub.lastOutput, "找到了 20 个组件");
    assert.equal(sub.toolRunning, false);

    // sidechain 行不污染主消息流（只有 user + assistant 主线两条）
    assert.equal(parsed.messages.length, 2);
  });

  it("未完成的 Task：done=false，当前工具与 toolRunning 反映运行态", () => {
    const content = transcript([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-08T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "toolu_running",
              name: "Agent",
              input: { description: "全量审计", subagent_type: "general-purpose", prompt: "审计" },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "sa1",
        isSidechain: true,
        timestamp: "2026-10-08T10:00:08.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "inner1", name: "Bash", input: { command: "ls -la" } }],
        },
      },
    ]);

    const parsed = parseClaudeTranscript(content);
    const sub = parsed.subAgents[0];
    assert.equal(sub.done, false);
    assert.equal(sub.toolRunning, true);
    assert.match(sub.currentTool ?? "", /ls -la/);
  });

  it("tool_result is_error=true → error 记录", () => {
    const content = transcript([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-08T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_fail", name: "Task", input: { prompt: "x" } }],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-10-08T10:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_fail", content: "boom", is_error: true }],
        },
      },
    ]);

    const parsed = parseClaudeTranscript(content);
    const sub = parsed.subAgents[0];
    assert.equal(sub.done, true);
    assert.equal(sub.error, true);
  });

  it("无 Task 的普通会话：subAgents 为空数组", () => {
    const content = transcript([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-08T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_1",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }],
        },
      },
    ]);
    const parsed = parseClaudeTranscript(content);
    assert.deepEqual(parsed.subAgents, []);
  });
});

describe("buildClaudeSubAgentActivity: 面板映射", () => {
  it("映射名称/状态/截断；sessionId 回指父会话（无独立会话文件）", () => {
    const parsed = parseClaudeTranscript(
      transcript([
        {
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-10-08T10:00:00.000Z",
          message: {
            role: "assistant",
            id: "msg_1",
            content: [
              {
                type: "tool_use",
                id: "toolu_xyz98765",
                name: "Task",
                input: { description: "任务A", subagent_type: "Explore", prompt: "p" },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "u1",
          timestamp: "2026-10-08T10:00:05.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_xyz98765", content: "r".repeat(300) }],
          },
        },
      ]),
    );

    const agents = buildClaudeSubAgentActivity("parent-1", parsed.subAgents);
    assert.equal(agents.length, 1);
    const a = agents[0];
    assert.equal(a.sessionId, "parent-1");
    assert.equal(a.name, "Explore#xyz98765");
    assert.equal(a.status, "idle");
    assert.equal(a.done, true);
    assert.ok((a.resultSummary ?? "").length <= 161); // SUMMARY_LIMIT=160 + 省略号
  });
});
