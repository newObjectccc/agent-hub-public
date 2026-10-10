/**
 * codex rollout 解析与适配层纯函数测试：
 * - message（user 消息注入包装剥离 / assistant 全渲染 / developer 跳过）
 * - function_call / function_call_output / custom_tool_call 配对折叠
 * - event_msg 活动流（CommandExecution/FileChange/McpToolCall/Extension，桌面 app）
 * - token_usage_record 用量采样、compacted 压缩边界、archived_sessions 归档扫描
 * - 损坏行 / 未知行优雅跳过（绝不抛错）
 * - session_index 名字优先、fork 的 id 重写、新建 rollout 构造
 * 风格照 claude-subagents.test.ts（node:test + assert，fixture 行结构照真实 app 会话
 * rollout 样本逐字段构造，不碰真实磁盘；归档扫描用 tmp 目录）。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  activityFromEventPayload,
  buildCodexNewRollout,
  buildCodexSessionSummary,
  buildSessionIndexLine,
  codexSummaries,
  groupCodexSegments,
  parseCodexRollout,
  parseCodexSessionIndex,
  parseCodexUsageFile,
  rewriteCodexRolloutIds,
  scanCodexSessions,
  sessionIdFromRolloutFileName,
  isCodexRolloutFileName,
  summarizeCodexToolCall,
  usageSampleFromTokenUsageRow,
} from "../adapters/codex-rollout.js";
import type { SessionListItem } from "../types.js";

const SID = "019e67ea-c861-78a1-b429-119496dac86e";
const CWD = "/Users/me/Workspace/demo";

const row = (obj: Record<string, unknown>): string => JSON.stringify(obj);
const rollout = (lines: string[]): string => lines.join("\n") + "\n";

function meta(ts = "2026-05-27T05:32:12.687Z"): string {
  return row({
    timestamp: ts,
    ordinal: 0,
    type: "session_meta",
    payload: { session_id: SID, id: SID, timestamp: ts, cwd: CWD, originator: "codex-tui", cli_version: "0.143.0" },
  });
}

function userMsg(text: string, ts = "2026-05-27T05:32:20.000Z", extra: Record<string, unknown> = {}): string {
  return row({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }], ...extra },
  });
}

function assistantMsg(text: string, ts = "2026-05-27T05:32:30.000Z", phase = "final_answer"): string {
  return row({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase },
  });
}

function funcCall(callId: string, name: string, args: unknown, ts = "2026-05-27T05:32:35.361Z"): string {
  return row({
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: callId },
  });
}

function funcOutput(callId: string, output: unknown, ts = "2026-05-27T05:32:35.505Z"): string {
  return row({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });
}

describe("parseCodexRollout：消息解析", () => {
  it("session_meta → sessionId/cwd；时间戳取最后一条合法值；developer/event_msg/未知行跳过", () => {
    const content = rollout([
      meta(),
      row({ timestamp: "2026-05-27T05:32:12.691Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      row({
        timestamp: "2026-05-27T05:32:12.693Z",
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>\n…" }] },
      }),
      userMsg("帮我看看这个 bug"),
      assistantMsg("好的，我先复现"),
      row({ timestamp: "2026-05-27T05:32:40.000Z", type: "turn_context", payload: { turn_id: "t1", cwd: CWD } }),
      row({ timestamp: "2026-05-27T05:33:28.260Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.sessionId, SID);
    assert.equal(parsed.cwd, CWD);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].role, "user");
    assert.equal(parsed.messages[0].text, "帮我看看这个 bug");
    assert.equal(parsed.messages[1].role, "assistant");
    assert.equal(parsed.messages[1].text, "好的，我先复现");
    assert.equal(parsed.updatedAtMs, Date.parse("2026-05-27T05:33:28.260Z"));
    // name 兜底 = 首条真实 user 文本
    assert.equal(parsed.name, "帮我看看这个 bug");
  });

  it("user 注入包装剥离：## My request 两种标记 + meta 前缀消息跳过 + 图片声明标签剥掉", () => {
    const content = rollout([
      meta(),
      userMsg("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
      userMsg("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"),
      userMsg("# AGENTS.md instructions for /Users/me/Workspace/demo\n\n<INSTRUCTIONS>\n…"),
      userMsg(
        "\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n我肯定是要做成验证标准里的收集页面\n\n这样后续也好接入通知系统\n<image name=[Image #1] path=\"/tmp/a.png\"></image>",
      ),
      userMsg(
        "\n<in-app-browser-context source=\"ambient-ui-state\">\n…\n</in-app-browser-context>\n\n## My request for Codex:\nfixedx@example.com\n",
      ),
    ]);
    const parsed = parseCodexRollout(content);
    // meta 消息全跳过，两条带标记的取真实输入
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].text, "我肯定是要做成验证标准里的收集页面\n\n这样后续也好接入通知系统");
    assert.equal(parsed.messages[1].text, "fixedx@example.com");
    // name 兜底取首条真实 user 文本
    assert.equal(parsed.name, "我肯定是要做成验证标准里的收集页面\n\n这样后续也好接入通知系统");
  });

  it("图片消息：input_image → MessageDto.images；纯图消息带 [image] 占位文本", () => {
    const content = rollout([
      meta(),
      row({
        timestamp: "2026-05-27T05:32:20.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<image name=[Image #1]></image>[Image #1],这是什么情况？" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      }),
      row({
        timestamp: "2026-05-27T05:32:25.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<image name=[Image #1]>" },
            { type: "input_image", image_url: "data:image/png;base64,BBBB" },
          ],
        },
      }),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 2);
    // 图片声明标签剥掉，[Image #1] 指代保留
    assert.equal(parsed.messages[0].text, "[Image #1],这是什么情况？");
    assert.deepEqual(parsed.messages[0].images, [{ url: "data:image/png;base64,AAAA", alt: null }]);
    assert.equal(parsed.messages[1].text, "[image]");
    assert.deepEqual(parsed.messages[1].images, [{ url: "data:image/png;base64,BBBB", alt: null }]);
  });
});

describe("parseCodexRollout：工具调用折叠", () => {
  it("function_call 折进其前的 assistant 消息，output 回填状态与预览（arguments 是 JSON 字符串）", () => {
    const content = rollout([
      meta(),
      userMsg("帮我搜一下用法"),
      assistantMsg("我先搜代码", "2026-05-27T05:32:33.008Z", "commentary"),
      funcCall("call_a1", "exec_command", { cmd: "rg -n 'foo' .", workdir: CWD, max_output_tokens: 12000 }),
      funcCall("call_a2", "exec_command", { cmd: "rg --files .", workdir: CWD }),
      funcOutput("call_a1", "Chunk ID: 1\nOutput:\n./a.ts:1:foo"),
      funcOutput("call_a2", "b.ts\nc.ts"),
      assistantMsg("搜到 3 处引用"),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 3);
    const withTools = parsed.messages[1];
    assert.equal(withTools.role, "assistant");
    assert.equal(withTools.text, "我先搜代码");
    assert.equal(withTools.toolCalls.length, 2);
    assert.equal(withTools.toolCalls[0].name, "exec_command");
    // exec_command 参数键是 cmd：摘要归一化取 command/cmd 首个字符串值
    assert.equal(withTools.toolCalls[0].summary, "rg -n 'foo' .");
    assert.equal(withTools.toolCalls[0].status, "done");
    assert.ok(withTools.toolCalls[0].resultPreview?.startsWith("Chunk ID: 1"));
    assert.equal(withTools.toolCalls[1].status, "done");
    assert.equal(withTools.toolCalls[1].resultPreview, "b.ts\nc.ts");
  });

  it("custom_tool_call（apply_patch 自由文本 input）同口径折叠；无前序 assistant 时建空消息承接", () => {
    const content = rollout([
      meta(),
      userMsg("修一下 bug"),
      row({
        timestamp: "2026-05-27T05:32:35.361Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_p1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n",
        },
      }),
      funcOutput("call_p1", "Success. Updated the following files:\nM a.ts"),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 2);
    const holder = parsed.messages[1];
    assert.equal(holder.role, "assistant");
    assert.equal(holder.text, ""); // 无 commentary 文本：空 assistant 承接工具
    assert.equal(holder.toolCalls.length, 1);
    assert.equal(holder.toolCalls[0].name, "apply_patch");
    assert.ok(holder.toolCalls[0].summary.startsWith("*** Begin Patch"));
    assert.equal(holder.toolCalls[0].status, "done");
  });

  it("孤儿 function_call_output 转 toolResult 消息；output 为 block[] 时取 text 块", () => {
    const content = rollout([
      meta(),
      funcOutput("call_orphan", [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }, { type: "output_text", text: "看这个截图" }]),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, "toolResult");
    assert.equal(parsed.messages[0].text, "看这个截图");
  });
});

describe("parseCodexRollout：容错", () => {
  it("损坏行 / 未知 type / 未知 response_item 一律跳过且不抛错", () => {
    const content = [
      meta(),
      "{ 这行不是合法 JSON",
      row({ timestamp: "2026-05-27T05:32:13.000Z", type: "some_future_type", payload: { foo: 1 } }),
      row({ timestamp: "2026-05-27T05:32:14.000Z", type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "xxx" } }),
      row({
        timestamp: "2026-05-27T05:32:15.000Z",
        type: "response_item",
        payload: { type: "agent_message", id: "amsg_1", author: "/root/sub", content: [{ type: "input_text", text: "子代理消息" }] },
      }),
      userMsg("只有这条该出现"),
      "12345",
      "",
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].text, "只有这条该出现");
    assert.equal(parsed.sessionId, SID);
  });

  it("空内容 / 无 session_meta：fallback 兜底，name 为 null", () => {
    const parsed = parseCodexRollout("", { sessionId: "fallback-id", cwd: "/tmp/x" });
    assert.equal(parsed.sessionId, "fallback-id");
    assert.equal(parsed.cwd, "/tmp/x");
    assert.equal(parsed.name, null);
    assert.deepEqual(parsed.messages, []);
    assert.equal(parsed.updatedAtMs, null);
  });
});

describe("列表摘要与会话名索引", () => {
  it("codexSummaries 与 pi/claude 同口径（截断 120 字符，取最后一条）", () => {
    const parsed = parseCodexRollout(rollout([meta(), userMsg("第一条问题"), assistantMsg("第一条回答"), userMsg("第二条问题")]));
    const { lastUserMessage, lastAssistantMessage } = codexSummaries(parsed.messages);
    assert.equal(lastUserMessage, "第二条问题");
    assert.equal(lastAssistantMessage, "第一条回答");
  });

  it("parseCodexSessionIndex：坏行跳过、同 id 取最后一行（最新命名）", () => {
    const content = [
      row({ id: "a", thread_name: "旧名字", updated_at: "2026-05-11T07:47:26Z" }),
      "broken line",
      row({ id: "a", thread_name: "新名字", updated_at: "2026-05-12T07:47:26Z" }),
      row({ id: "b", thread_name: "  ", updated_at: "2026-05-12T07:47:26Z" }),
    ].join("\n");
    const map = parseCodexSessionIndex(content);
    assert.equal(map.get("a"), "新名字");
    assert.equal(map.has("b"), false); // 空白 thread_name 不登记
  });

  it("buildCodexSessionSummary：索引名优先、缺失回退首条 user 文本；isSubAgent 按命名规则", () => {
    const content = rollout([meta(), userMsg("帮我看看部署脚本"), assistantMsg("好的")]);
    const plain = buildCodexSessionSummary("/tmp/rollout-x.jsonl", content, 1779859932000);
    assert.ok(plain);
    assert.equal(plain.id, SID);
    assert.equal(plain.source, "codex");
    assert.equal(plain.name, "帮我看看部署脚本");
    assert.equal(plain.cwd, CWD);
    assert.equal(plain.messageCount, 2);
    assert.equal(plain.isSubAgent, false);
    assert.equal(plain.parentSessionId, null);
    assert.equal(plain.updatedAt, new Date(Date.parse("2026-05-27T05:32:30.000Z")).toISOString());

    const named = buildCodexSessionSummary("/tmp/rollout-x.jsonl", content, 1779859932000, { name: "deploy#abc123" });
    assert.ok(named);
    assert.equal(named.name, "deploy#abc123");
    assert.equal(named.isSubAgent, true); // `<type>#<hex>` 命名规则同 pi 口径
  });
});

describe("适配层纯函数（fork 重写 / 新建 rollout / 文件名）", () => {
  it("rewriteCodexRolloutIds：session 标识替换，call_id/item id 保留，坏行原样", () => {
    const badLine = "{ 坏行";
    const content = rollout([
      meta(),
      funcCall("call_keep_1", "exec_command", { cmd: "ls" }),
      funcOutput("call_keep_1", "ok"),
      badLine,
    ]);
    const out = rewriteCodexRolloutIds(content, SID, "new-uuid-1");
    const lines = out.trim().split("\n");
    // 坏行原样保留
    assert.equal(lines[3], badLine);
    const metaRow = JSON.parse(lines[0]) as Record<string, Record<string, unknown>>;
    assert.equal(metaRow.payload.session_id, "new-uuid-1");
    assert.equal(metaRow.payload.id, "new-uuid-1");
    const callRow = JSON.parse(lines[1]) as Record<string, Record<string, unknown>>;
    assert.equal(callRow.payload.call_id, "call_keep_1"); // call_id 不动
    // 再解析：sessionId 已是新 id，工具历史完整
    const parsed = parseCodexRollout(out);
    assert.equal(parsed.sessionId, "new-uuid-1");
    assert.equal(parsed.messages[0].toolCalls[0].summary, "ls");
    assert.equal(parsed.messages[0].toolCalls[0].status, "done");
  });

  it("rewriteCodexRolloutIds 后工具历史可解析（空 assistant 承接 + output 回填）", () => {
    const content = rollout([meta(), funcCall("call_x", "exec_command", { cmd: "ls" }), funcOutput("call_x", "a.ts")]);
    const parsed = parseCodexRollout(rewriteCodexRolloutIds(content, SID, "new-uuid-2"));
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].toolCalls[0].status, "done");
  });

  it("buildCodexNewRollout：仅一条 session_meta，可被解析层识别", () => {
    const ts = "2026-10-09T02:53:50.000Z";
    const content = buildCodexNewRollout({ sessionId: SID, cwd: CWD, timestamp: ts });
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.sessionId, SID);
    assert.equal(parsed.cwd, CWD);
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.updatedAtMs, Date.parse(ts));
    const rows = content.trim().split("\n");
    assert.equal(rows.length, 1);
    assert.equal((JSON.parse(rows[0]) as { type: string }).type, "session_meta");
  });

  it("buildSessionIndexLine / sessionIdFromRolloutFileName（含分段命名 <uuid>_<uuid2> 取首个）", () => {
    const line = buildSessionIndexLine(SID, "我的会话", "2026-10-09T02:53:50.000Z");
    assert.deepEqual(parseCodexSessionIndex(line).get(SID), "我的会话");
    assert.equal(sessionIdFromRolloutFileName(`rollout-2026-05-27T13-31-40-${SID}.jsonl`), SID);
    assert.equal(sessionIdFromRolloutFileName("skill-injections.jsonl"), null);
    // 续写分段命名：`<uuid>_<uuid2>` → 取首个 uuid（段内 session_meta 也是它）
    const segName = `rollout-2026-09-17T19-19-19-${SID}_01a0af17-aafd-7d03-a157-cbccd2205c9b.jsonl`;
    assert.equal(isCodexRolloutFileName(segName), true);
    assert.equal(sessionIdFromRolloutFileName(segName), SID);
  });

  it("summarizeCodexToolCall：cmd 归一化 / 自由文本截断 / 非法 JSON 原样", () => {
    assert.equal(summarizeCodexToolCall("exec_command", { cmd: "git status" }, ""), "git status");
    assert.equal(summarizeCodexToolCall("apply_patch", "*** Begin Patch\nabc", "*** Begin Patch\nabc"), "*** Begin Patch\nabc");
    assert.equal(summarizeCodexToolCall("x", "not json {", "not json {"), "not json {");
  });
});

describe("分段归并（同一会话跨多个 rollout 文件）", () => {
  const summary = (over: Partial<Omit<SessionListItem, "status">>): Omit<SessionListItem, "status"> => ({
    id: SID,
    source: "codex",
    name: null,
    cwd: CWD,
    updatedAt: "2026-09-17T11:19:18.987Z",
    messageCount: 2,
    lastUserMessage: "问题一",
    lastAssistantMessage: "回答一",
    sessionFile: "/tmp/seg-a.jsonl",
    isSubAgent: false,
    parentSessionId: null,
    ...over,
  });

  it("同 id 多段归并：计数求和 / updatedAt 取最新 / lastUser 从新到旧取非空 / name 取最早段 / sessionFile 指最新段", () => {
    const groups = groupCodexSegments([
      { file: "/tmp/seg-b.jsonl", summary: summary({ updatedAt: "2026-09-24T06:26:13.627Z", messageCount: 8, lastUserMessage: "问题二", lastAssistantMessage: null, name: "段二名字", sessionFile: "/tmp/seg-b.jsonl" }) },
      { file: "/tmp/seg-a.jsonl", summary: summary({ name: "段一名字" }) },
    ]);
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.deepEqual(g.files, ["/tmp/seg-a.jsonl", "/tmp/seg-b.jsonl"]); // 时间序
    assert.equal(g.summary.messageCount, 10);
    assert.equal(g.summary.updatedAt, "2026-09-24T06:26:13.627Z");
    assert.equal(g.summary.lastUserMessage, "问题二"); // 新段优先
    assert.equal(g.summary.lastAssistantMessage, "回答一"); // 新段为空 → 回退旧段
    assert.equal(g.summary.name, "段一名字"); // 最早段的首条 user 文本
    assert.equal(g.summary.sessionFile, "/tmp/seg-b.jsonl"); // 最新段（tail/后续写入所在）
  });

  it("不同 id 不合并", () => {
    const groups = groupCodexSegments([
      { file: "/tmp/a.jsonl", summary: summary({}) },
      { file: "/tmp/b.jsonl", summary: summary({ id: "other-id" }) },
    ]);
    assert.equal(groups.length, 2);
  });

  it("消息 id 跨段唯一且稳定（idPrefix 按文件：归并解析与 tail 单文件解析不漂移）", () => {
    const content = rollout([meta(), userMsg("第一条"), assistantMsg("好的")]);
    const a = parseCodexRollout(content, { idPrefix: "aaaa" });
    const again = parseCodexRollout(content, { idPrefix: "aaaa" });
    const b = parseCodexRollout(content, { idPrefix: "bbbb" });
    assert.deepEqual(a.messages.map((m) => m.id), again.messages.map((m) => m.id)); // 稳定
    const ids = new Set([...a.messages, ...b.messages].map((m) => m.id));
    assert.equal(ids.size, 4); // 跨段唯一
  });
});

// ---------- 桌面 app 会话真实行结构 fixture（字段照实测 rollout 样本逐个构造，数据虚构） ----------

function metaRow(ts: string, sid: string): string {
  return row({
    timestamp: ts,
    ordinal: 0,
    type: "session_meta",
    payload: { session_id: sid, id: sid, timestamp: ts, cwd: CWD, originator: "codex_work_desktop", cli_version: "0.159.0-alpha.12.1" },
  });
}

/** event_msg.item_completed 行（app 活动流，实测 payload 键集：type/thread_id/turn_id/item/started_at_ms/completed_at_ms） */
function itemCompleted(item: Record<string, unknown>, ts = "2026-10-07T11:44:59.616Z"): string {
  return row({
    timestamp: ts,
    ordinal: 12,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: SID,
      turn_id: "01a1162e-49bd-78b0-8d08-435d228e665b",
      item,
      started_at_ms: 1791373499616,
      completed_at_ms: 1791373499616,
    },
  });
}

describe("parseCodexRollout：event_msg 活动流（桌面 app）", () => {
  it("CommandExecution → 活动 toolCall 折进 assistant：parsed_cmd read → read_file + 路径，stdout 预览", () => {
    const content = rollout([
      meta(),
      userMsg("帮我看下技能文件"),
      assistantMsg("我先读文件", "2026-10-07T11:44:58.000Z", "commentary"),
      itemCompleted({
        type: "CommandExecution",
        id: "exec-fa1c22bb-14cd-4db1-a53b-0569e0a99739",
        process_id: "65463",
        command: ["/bin/zsh", "-lc", "cat /Users/me/.agents/skills/ego-browser/SKILL.md"],
        cwd: "file:///Users/me/Workspace/demo",
        parsed_cmd: [
          {
            type: "read",
            cmd: "cat /Users/me/.agents/skills/ego-browser/SKILL.md",
            name: "SKILL.md",
            path: "/Users/me/.agents/skills/ego-browser/SKILL.md",
          },
        ],
        source: "unified_exec_startup",
        status: "completed",
        stdout: "---\nname: ego-browser",
        stderr: "",
        aggregated_output: "---\nname: ego-browser",
        exit_code: 0,
        duration: 12,
        formatted_output: "---\nname: ego-browser",
      }),
    ]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 2);
    const toolCalls = parsed.messages[1].toolCalls;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, "read_file");
    assert.equal(toolCalls[0].summary, "/Users/me/.agents/skills/ego-browser/SKILL.md");
    assert.equal(toolCalls[0].status, "done");
    assert.equal(toolCalls[0].resultPreview, "---\nname: ego-browser");
  });

  it("无 parsed_cmd 的命令 → exec_command + shell 文本；failed → error + stderr 预览", () => {
    const content = rollout([
      meta(),
      userMsg("跑下命令"),
      assistantMsg("好的"),
      itemCompleted({
        type: "CommandExecution",
        id: "exec-2",
        process_id: "65464",
        command: ["/bin/zsh", "-lc", "rg -n 'foo' ."],
        cwd: "file:///Users/me/Workspace/demo",
        parsed_cmd: [],
        source: "unified_exec_startup",
        status: "failed",
        stdout: "",
        stderr: "rg: command not found",
        aggregated_output: "rg: command not found",
        exit_code: 127,
        duration: 3,
        formatted_output: "",
      }),
    ]);
    const parsed = parseCodexRollout(content);
    const call = parsed.messages[1].toolCalls[0];
    assert.equal(call.name, "exec_command");
    assert.equal(call.summary, "rg -n 'foo' .");
    assert.equal(call.status, "error");
    assert.equal(call.resultPreview, "rg: command not found");
  });

  it("FileChange → apply_patch + 文件清单；McpToolCall → tool 名 + 参数摘要；Extension → kind + query", () => {
    const content = rollout([
      meta(),
      userMsg("改下任务板"),
      assistantMsg("我来改"),
      itemCompleted({
        type: "FileChange",
        id: "exec-24ca4ec5-9f8a-4582-a33d-99a498c56457",
        changes: { "/Users/me/Workspace/demo/TASK_BOARD.md": { type: "update", unified_diff: "@@ -2,2 +2,18 @@\n\n+x" } },
        status: "completed",
        stdout: "Success. Updated the following files:\nM TASK_BOARD.md",
        stderr: "",
      }),
      itemCompleted({
        type: "McpToolCall",
        id: "exec-13e6cbf8-d13f-4294-b773-ddc925015e53",
        server: "codex_apps",
        tool: "linear.list_projects",
        arguments: { query: "demo", includeArchived: true, limit: 50 },
        connectorId: "asdk_app_x",
        linkId: "link_x",
        appName: "Linear",
        actionName: "list_projects",
        readOnlyHint: true,
        status: "failed",
        result: { content: [{ type: "text", text: "This app connection requires reauthentication." }], structuredContent: { error: "reauth" } },
        duration: 200,
      }),
      itemCompleted({
        type: "Extension",
        kind: "web.search",
        id: "exec-81319fd8-8b22-44da-9e75-8cca55d571c2",
        query: "https://example.com/login",
        action: { type: "openPage", url: "https://example.com/login" },
        results: [{ type: "text_result", domain: "example.com", ref_id: "turn0view0", snippet: "Total lines: 185" }],
      }),
    ]);
    const parsed = parseCodexRollout(content);
    const calls = parsed.messages[1].toolCalls;
    assert.equal(calls.length, 3);
    assert.equal(calls[0].name, "apply_patch");
    assert.equal(calls[0].summary, "/Users/me/Workspace/demo/TASK_BOARD.md (update)");
    assert.equal(calls[0].status, "done");
    assert.equal(calls[0].resultPreview, "Success. Updated the following files:\nM TASK_BOARD.md");
    assert.equal(calls[1].name, "linear.list_projects");
    assert.ok(calls[1].summary.includes('"query":"demo"'));
    assert.equal(calls[1].status, "error"); // McpToolCall.status=failed
    assert.equal(calls[1].resultPreview, "This app connection requires reauthentication.");
    assert.equal(calls[2].name, "web.search");
    assert.equal(calls[2].summary, "https://example.com/login");
    assert.equal(calls[2].resultPreview, null);
  });

  it("Reasoning/AgentMessage/UserMessage/ImageView/ContextCompaction 与生命周期事件跳过；无 assistant 时空 assistant 承接活动", () => {
    const content = rollout([
      meta(),
      itemCompleted({ type: "Reasoning", id: "rs_0fd66a93", summary_text: [], raw_content: [] }),
      itemCompleted({ type: "AgentMessage", id: "msg_0fd66a93", content: [{ type: "Text", text: "我先看进度板" }], phase: "commentary" }),
      itemCompleted({ type: "UserMessage", id: "01a1162e-5cdf", content: [{ type: "text", text: "与 response_item 重复的用户消息" }] }),
      itemCompleted({ type: "ImageView", id: "exec-4ccb4b50-600f-42cb-a047-bfebef41a3e1", path: "file:///tmp/linear-projects.png" }),
      itemCompleted({ type: "ContextCompaction", id: "01a11643-ee57-7c41-9f64-694ef650f8ac" }),
      row({
        timestamp: "2026-10-07T11:44:54.918Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1", root_turn_id: "t1", started_at: 1791373494, model_context_window: 258400, collaboration_mode_kind: "default" },
      }),
      row({
        timestamp: "2026-10-07T11:45:10.335Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { total_tokens: 33099 }, last_token_usage: {}, model_context_window: 258400 }, rate_limits: {} },
      }),
      itemCompleted({
        type: "CommandExecution",
        id: "exec-7",
        process_id: "1",
        command: ["/bin/zsh", "-lc", "ls"],
        cwd: "file:///Users/me/Workspace/demo",
        parsed_cmd: [],
        source: "unified_exec_startup",
        status: "completed",
        stdout: "a.ts",
        stderr: "",
        aggregated_output: "a.ts",
        exit_code: 0,
        duration: 1,
        formatted_output: "a.ts",
      }),
    ]);
    const parsed = parseCodexRollout(content);
    // 只有活动承接的空 assistant 一条消息（其余活动/事件全跳过，不与 response_item 重复）
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, "assistant");
    assert.equal(parsed.messages[0].text, "");
    assert.equal(parsed.messages[0].toolCalls.length, 1);
    assert.equal(parsed.messages[0].toolCalls[0].name, "exec_command");
    // token_count 事件是 UI 快照，不重复计入采样
    assert.equal(parsed.usageSamples.length, 0);
    // 未知活动项 / 非 item_completed 一律 null（优雅跳过）
    assert.equal(activityFromEventPayload({ type: "item_completed", item: { type: "FutureThing" } }), null);
    assert.equal(activityFromEventPayload({ type: "token_count" }), null);
    assert.equal(activityFromEventPayload("not-a-record"), null);
  });
});

describe("token_usage_record 用量采样（真实行结构）", () => {
  /** token_usage_record 行（实测键集：thread_id/turn_id/session_id/root_turn_id/response_id/usage/turn_token_usage/thread_token_usage） */
  const tokenUsageRow = (ts: string, usage: Record<string, unknown>): string =>
    row({
      timestamp: ts,
      ordinal: 16,
      type: "token_usage_record",
      payload: {
        thread_id: SID,
        turn_id: "01a1162e-49bd-78b0-8d08-435d228e665b",
        session_id: SID,
        root_turn_id: "01a1162e-49bd-78b0-8d08-435d228e665b",
        response_id: "resp_0fd66a932985d764016ac630bd187087d0831b42540f06e702",
        usage,
        turn_token_usage: { ...usage },
        thread_token_usage: { ...usage }, // 累计值：只取 usage 求和，累计不叠加
      },
    });
  const REAL_USAGE = { input_tokens: 32849, cached_input_tokens: 22784, cache_write_input_tokens: 0, output_tokens: 250, reasoning_output_tokens: 0, total_tokens: 33099 };

  it("parseCodexRollout：token_usage_record 不产生消息，按 usage 字段映射采样（对齐 pi message.usage 口径）", () => {
    const content = rollout([meta(), userMsg("问题"), assistantMsg("回答"), tokenUsageRow("2026-10-07T11:45:09.691Z", REAL_USAGE)]);
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.messages.length, 2); // 采样行不进 chat
    assert.equal(parsed.usageSamples.length, 1);
    assert.deepEqual(parsed.usageSamples[0], {
      timestampMs: Date.parse("2026-10-07T11:45:09.691Z"),
      totalTokens: 33099,
      input: 32849,
      output: 250,
      cacheRead: 22784,
      cacheWrite: 0,
      reasoning: 0,
      costTotal: null,
    });
    // updatedAtMs 覆盖采样行时间
    assert.equal(parsed.updatedAtMs, Date.parse("2026-10-07T11:45:09.691Z"));
  });

  it("parseCodexUsageFile：sessionId 取 session_meta、name 取首条真实 user；坏行/缺 usage 跳过", () => {
    const content = rollout([
      meta(),
      userMsg("帮我看看 linear 的 issue"),
      tokenUsageRow("2026-10-07T11:45:09.691Z", { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 7, total_tokens: 127 }),
      "{ 坏行",
      row({ timestamp: "2026-10-07T11:47:00.000Z", type: "token_usage_record", payload: { session_id: SID } }), // 无 usage → 跳过
    ]);
    const parsed = parseCodexUsageFile(content);
    assert.equal(parsed.sessionId, SID);
    assert.equal(parsed.name, "帮我看看 linear 的 issue");
    assert.equal(parsed.samples.length, 1);
    assert.deepEqual(parsed.samples[0], {
      timestampMs: Date.parse("2026-10-07T11:45:09.691Z"),
      totalTokens: 127,
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 0,
      reasoning: 7,
      costTotal: null,
    });
    // 无 session_meta：文件名 uuid 兜底
    assert.equal(parseCodexUsageFile(tokenUsageRow("2026-10-07T11:45:09.691Z", REAL_USAGE), "fallback-id").sessionId, "fallback-id");
  });

  it("usageSampleFromTokenUsageRow：非 token_usage_record / 缺 payload.usage → null（宽容跳过）", () => {
    assert.equal(usageSampleFromTokenUsageRow({ type: "session_meta", payload: {} }), null);
    assert.equal(usageSampleFromTokenUsageRow({ type: "token_usage_record", payload: { session_id: SID } }), null);
    assert.equal(usageSampleFromTokenUsageRow("not-a-record"), null);
  });
});

describe("compacted 上下文压缩边界", () => {
  /** compacted 行（实测：payload.message + replacement_history 压缩后上下文快照） */
  const compactedRow = (ts = "2026-10-07T12:16:39.778Z"): string =>
    row({
      timestamp: ts,
      ordinal: 477,
      type: "compacted",
      payload: {
        message: "",
        replacement_history: [
          {
            type: "message",
            id: "msg_01a1162e-5cdf-7ca3-961f-408258d93c65",
            role: "user",
            content: [{ type: "input_text", text: "你找一下我的 linear 上未完成的 issue" }],
            internal_chat_message_metadata_passthrough: { turn_id: "t1", create_time: 1791373499.615588, content_item_kinds: ["user.text"] },
          },
        ],
      },
    });

  it("compacted → [context compacted] 轻量条目（与 pi compaction 同口径）；replacement_history 不重复解析", () => {
    const content = rollout([meta(), userMsg("问题"), assistantMsg("回答"), compactedRow()]);
    const parsed = parseCodexRollout(content);
    // replacement_history 里的 user 消息与压缩前 response_item 重复 → 不再解析，只加边界标记
    assert.equal(parsed.messages.length, 3);
    const marker = parsed.messages[2];
    assert.equal(marker.role, "custom");
    assert.equal(marker.text, "[context compacted]");
  });

  it("压缩点清空折叠状态：跨压缩点的 output 不回填旧 assistant，转孤儿 toolResult（不崩、连续性合理）", () => {
    const content = rollout([
      meta(),
      userMsg("问题"),
      assistantMsg("回答"),
      funcCall("call_before", "exec_command", { cmd: "ls" }),
      compactedRow(),
      funcOutput("call_before", "a.ts"),
    ]);
    const parsed = parseCodexRollout(content);
    assert.deepEqual(parsed.messages.map((m) => m.role), ["user", "assistant", "custom", "toolResult"]);
    assert.equal(parsed.messages[1].toolCalls[0].status, "pending"); // 不跨压缩点回填
    assert.equal(parsed.messages[3].text, "a.ts");
  });
});

describe("archived_sessions 归档扫描", () => {
  const SID2 = "019e1a99-10c7-73a1-ba76-f3c152539e1d";
  const dirRef: { dir: string } = { dir: "" };
  after(async () => {
    if (dirRef.dir !== "") await rm(dirRef.dir, { recursive: true, force: true });
  });

  it("归档目录（~/.codex/archived_sessions 平铺）会话进列表：archived 标注 + 排列表尾部", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-codex-arch-"));
    dirRef.dir = dir;
    const sessionsDir = join(dir, "sessions");
    const archivedDir = join(dir, "archived_sessions");
    await mkdir(join(sessionsDir, "2026", "10", "07"), { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "2026", "10", "07", `rollout-2026-10-07T19-44-29-${SID}.jsonl`),
      rollout([meta(), userMsg("活跃会话"), assistantMsg("好的")]),
    );
    // 归档会话 updatedAt 更新（排尾逻辑必须压过时间序）；命名与 sessions 同规则
    await writeFile(
      join(archivedDir, `rollout-2026-05-12T13-11-39-${SID2}.jsonl`),
      rollout([metaRow("2026-10-08T00:00:00.000Z", SID2), userMsg("归档会话", "2026-10-08T00:01:00.000Z")]),
    );

    const { items, segments } = await scanCodexSessions(sessionsDir, new Map(), { archivedDir });
    assert.equal(items.length, 2);
    assert.equal(items[0].id, SID);
    assert.equal(items[0].archived, false);
    assert.equal(items[1].id, SID2); // 归档排尾（尽管 updatedAt 更新）
    assert.equal(items[1].archived, true);
    assert.equal(items[1].name, "归档会话");
    assert.deepEqual(segments.get(SID2), [join(archivedDir, `rollout-2026-05-12T13-11-39-${SID2}.jsonl`)]);
  });

  it("groupCodexSegments：任一分段在归档目录 → 整会话 archived（归档是会话级操作）", () => {
    const base: Omit<SessionListItem, "status"> = {
      id: SID,
      source: "codex",
      name: null,
      cwd: CWD,
      updatedAt: "2026-09-17T11:19:18.987Z",
      messageCount: 1,
      lastUserMessage: "问题",
      lastAssistantMessage: null,
      sessionFile: "/tmp/a.jsonl",
      isSubAgent: false,
      parentSessionId: null,
    };
    const groups = groupCodexSegments([
      { file: "/tmp/a.jsonl", summary: base },
      { file: "/tmp/archived_sessions/b.jsonl", summary: { ...base, updatedAt: "2026-09-24T06:26:13.627Z", sessionFile: "/tmp/archived_sessions/b.jsonl", archived: true } },
    ]);
    assert.equal(groups[0].summary.archived, true);
    assert.equal(groupCodexSegments([{ file: "/tmp/a.jsonl", summary: base }])[0].summary.archived, false);
  });
});
