/**
 * codex rollout 解析与适配层纯函数测试：
 * - message（user 消息注入包装剥离 / assistant 全渲染 / developer 跳过）
 * - function_call / function_call_output / custom_tool_call 配对折叠
 * - 损坏行 / 未知行优雅跳过（绝不抛错）
 * - session_index 名字优先、fork 的 id 重写、新建 rollout 构造
 * 风格照 claude-subagents.test.ts（node:test + assert，构造 fixture 不碰真实磁盘）。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildCodexNewRollout,
  buildCodexSessionSummary,
  buildSessionIndexLine,
  codexSummaries,
  groupCodexSegments,
  parseCodexRollout,
  parseCodexSessionIndex,
  rewriteCodexRolloutIds,
  sessionIdFromRolloutFileName,
  isCodexRolloutFileName,
  summarizeCodexToolCall,
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
