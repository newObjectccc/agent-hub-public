/**
 * Claude Code transcript 解析单测（fixture 取自本机 ~/.claude/projects 真实结构脱敏）。
 * 覆盖：user/assistant/tool_result 聚合折叠、ai-title 会话名、meta/未知行优雅跳过、
 * 坏行不崩、孤儿 tool_result、summary 行、history.jsonl cwd 兜底、文件扫描过滤。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildClaudeSessionSummary,
  claudeSummaries,
  findClaudeSessionFiles,
  isClaudeSessionFileName,
  parseClaudeHistoryIndex,
  parseClaudeTranscript,
  scanClaudeSessions,
} from "../adapters/claude-transcript.js";

const SID = "394b6cea-13f8-44e8-bb03-5cda75fa88b0";
const CWD = "/Users/me/Workspace/demo";

const fixtureLines: string[] = [
  // 元数据行（不进 chat）
  JSON.stringify({ type: "mode", mode: "normal", sessionId: SID }),
  JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: SID }),
  JSON.stringify({ type: "atis-latch", atis: "", sessionId: SID }),
  // 人类输入（string content）
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "帮我检查周报 KPI 口径" },
    uuid: "u1",
    timestamp: "2026-09-29T09:17:33.525Z",
    origin: { kind: "human" },
    promptSource: "typed",
    cwd: CWD,
    sessionId: SID,
    version: "2.1.267",
  }),
  // assistant：同一 message.id（msg_1）两行（thinking 块 + tool_use 块）
  JSON.stringify({
    parentUuid: "u1",
    type: "assistant",
    message: { id: "msg_1", role: "assistant", content: [{ type: "thinking", thinking: "先看目录" }] },
    uuid: "a1",
    timestamp: "2026-09-29T09:17:38.821Z",
    cwd: CWD,
    sessionId: SID,
  }),
  JSON.stringify({
    parentUuid: "a1",
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls -la" } }],
    },
    uuid: "a2",
    timestamp: "2026-09-29T09:17:39.391Z",
    cwd: CWD,
    sessionId: SID,
  }),
  // 工具结果（折叠进 msg_1 的 toolCalls）
  JSON.stringify({
    parentUuid: "a2",
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "call_1", type: "tool_result", content: "file1\nfile2", is_error: false }],
    },
    uuid: "u2",
    timestamp: "2026-09-29T09:17:41.243Z",
    toolUseResult: { stdout: "file1\nfile2", stderr: "", interrupted: false },
    sourceToolAssistantUUID: "a2",
    cwd: CWD,
    sessionId: SID,
  }),
  // assistant 文本消息
  JSON.stringify({
    parentUuid: "u2",
    type: "assistant",
    message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "好的，我先查 ETL 水位" }] },
    uuid: "a3",
    timestamp: "2026-09-29T09:17:59.196Z",
    cwd: CWD,
    sessionId: SID,
  }),
  // meta/伴随行（跳过）
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "<command-name>/theme</command-name>" },
    uuid: "u3",
    isMeta: true,
    timestamp: "2026-09-29T09:18:00.000Z",
    cwd: CWD,
    sessionId: SID,
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Image #1] 伴随描述" }] },
    uuid: "u4",
    isMeta: true,
    turnCompanion: true,
    timestamp: "2026-09-29T09:18:01.000Z",
    cwd: CWD,
    sessionId: SID,
  }),
  // 孤儿 tool_result（保留为 toolResult 消息）
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "call_orphan", type: "tool_result", content: "orphan output", is_error: true }],
    },
    uuid: "u5",
    timestamp: "2026-09-29T09:18:02.000Z",
    cwd: CWD,
    sessionId: SID,
  }),
  // 会话名 / 最近 prompt / 其它元数据
  JSON.stringify({ type: "ai-title", aiTitle: "KPI 口径检查", sessionId: SID }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "帮我检查周报 KPI 口径", leafUuid: "a3", sessionId: SID }),
  JSON.stringify({ type: "cost-state", sessionId: SID, totalCostUSD: 0.12 }),
  JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: {}, isSnapshotUpdate: false }),
  JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    durationMs: 1234,
    timestamp: "2026-09-29T09:18:03.000Z",
    uuid: "s1",
    cwd: CWD,
    sessionId: SID,
  }),
  // 坏行与未知结构（必须优雅跳过不崩）
  "this is not json {",
  JSON.stringify({ type: "totally-unknown-type", foo: 1 }),
  JSON.stringify({ noType: true }),
];

const fixture = fixtureLines.join("\n") + "\n";

describe("claude transcript: 解析映射", () => {
  it("user/assistant/tool_result 映射为契约 MessageDto（toolCalls 折叠、thinking 跳过）", () => {
    const parsed = parseClaudeTranscript(fixture);
    assert.equal(parsed.messages.length, 4);

    const [m1, m2, m3, m4] = parsed.messages;
    assert.equal(m1.role, "user");
    assert.equal(m1.id, "u1");
    assert.equal(m1.text, "帮我检查周报 KPI 口径");
    assert.equal(m1.timestamp, Date.parse("2026-09-29T09:17:33.525Z"));

    // 同 message.id 的两个 block 行聚合为一条 assistant 消息
    assert.equal(m2.role, "assistant");
    assert.equal(m2.id, "msg_1");
    assert.equal(m2.text, ""); // thinking 不进 chat
    assert.equal(m2.toolCalls.length, 1);
    assert.equal(m2.toolCalls[0].name, "Bash");
    assert.equal(m2.toolCalls[0].summary, "ls -la");
    assert.equal(m2.toolCalls[0].status, "done");
    assert.equal(m2.toolCalls[0].resultPreview, "file1\nfile2");

    assert.equal(m3.role, "assistant");
    assert.equal(m3.id, "msg_2");
    assert.equal(m3.text, "好的，我先查 ETL 水位");

    assert.equal(m4.role, "toolResult");
    assert.equal(m4.text, "orphan output");
  });

  it("sessionId / cwd / ai-title 会话名 / updatedAt 提取", () => {
    const parsed = parseClaudeTranscript(fixture);
    assert.equal(parsed.sessionId, SID);
    assert.equal(parsed.cwd, CWD);
    assert.equal(parsed.name, "KPI 口径检查");
    assert.equal(parsed.updatedAtMs, Date.parse("2026-09-29T09:18:03.000Z"));
  });

  it("meta 行、未知 type、坏行优雅跳过（不崩、不进消息）", () => {
    const parsed = parseClaudeTranscript(fixture);
    const texts = parsed.messages.map((m) => m.text);
    assert.ok(!texts.some((t) => t.includes("<command-name>")));
    assert.ok(!texts.some((t) => t.includes("伴随描述")));
    assert.ok(!texts.some((t) => t.includes("totally-unknown")));
  });

  it("summary 行映射为 role custom（与 pi branch_summary 口径一致）", () => {
    const content = [
      JSON.stringify({ type: "summary", summary: "之前在排查构建", leafUuid: "x", sessionId: SID }),
      fixtureLines[3],
    ].join("\n");
    const parsed = parseClaudeTranscript(content);
    assert.equal(parsed.messages[0].role, "custom");
    assert.match(parsed.messages[0].text, /\[summary\] 之前在排查构建/);
  });

  it("图片消息（无文本）降级为 [image] 占位", () => {
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看下这个截图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "xxxx" } },
        ],
      },
      uuid: "u9",
      timestamp: "2026-09-29T10:00:00.000Z",
      cwd: CWD,
      sessionId: SID,
    });
    const parsed = parseClaudeTranscript(content);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].text, "看下这个截图");

    const imageOnly = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "xxxx" } }] },
      uuid: "u10",
      timestamp: "2026-09-29T10:00:01.000Z",
      cwd: CWD,
      sessionId: SID,
    });
    const parsed2 = parseClaudeTranscript(imageOnly);
    assert.equal(parsed2.messages[0].text, "[image]");
  });

  it("fallback sessionId/cwd 在行缺失时兜底", () => {
    const parsed = parseClaudeTranscript(JSON.stringify({ type: "mode", mode: "normal" }), {
      sessionId: "fallback-id",
      cwd: "/fallback/cwd",
    });
    assert.equal(parsed.sessionId, "fallback-id");
    assert.equal(parsed.cwd, "/fallback/cwd");
  });

  it("claudeSummaries：lastUser/lastAssistant 截断口径与 pi 一致", () => {
    const long = "x".repeat(200);
    const parsed = parseClaudeTranscript(
      [
        JSON.stringify({ type: "user", message: { role: "user", content: long }, uuid: "u1", timestamp: "2026-09-29T10:00:00.000Z", sessionId: SID }),
        JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: long }] }, uuid: "a1", timestamp: "2026-09-29T10:00:01.000Z", sessionId: SID }),
      ].join("\n"),
    );
    const { lastUserMessage, lastAssistantMessage } = claudeSummaries(parsed.messages);
    assert.equal(lastUserMessage?.length, 121); // 120 + …
    assert.equal(lastAssistantMessage?.length, 121);
  });
});

describe("claude transcript: 摘要与扫描", () => {
  it("buildClaudeSessionSummary 字段齐全（source: claude）", () => {
    const summary = buildClaudeSessionSummary("/tmp/demo.jsonl", fixture, Date.parse("2026-09-29T09:00:00.000Z"));
    assert.ok(summary);
    assert.equal(summary.source, "claude");
    assert.equal(summary.id, SID);
    assert.equal(summary.name, "KPI 口径检查");
    assert.equal(summary.cwd, CWD);
    assert.equal(summary.messageCount, 4);
    assert.equal(summary.lastUserMessage, "帮我检查周报 KPI 口径");
    assert.equal(summary.lastAssistantMessage, "好的，我先查 ETL 水位");
    assert.equal(summary.updatedAt, "2026-09-29T09:18:03.000Z");
    assert.equal(summary.sessionFile, "/tmp/demo.jsonl");
  });

  it("buildClaudeSessionSummary：全空内容返回 null（不崩）", () => {
    assert.equal(buildClaudeSessionSummary("/tmp/empty.jsonl", "", Date.now()), null);
    assert.equal(buildClaudeSessionSummary("/tmp/broken.jsonl", "{{{\n###", Date.now()), null);
  });

  it("isClaudeSessionFileName：只认 <uuid>.jsonl", () => {
    assert.equal(isClaudeSessionFileName(`${SID}.jsonl`), true);
    assert.equal(isClaudeSessionFileName("skill-injections.jsonl"), false);
    assert.equal(isClaudeSessionFileName("history.jsonl"), false);
    assert.equal(isClaudeSessionFileName("not-a-uuid.jsonl"), false);
    assert.equal(isClaudeSessionFileName(`${SID}.txt`), false);
  });

  it("parseClaudeHistoryIndex：sessionId → project 映射，坏行跳过", () => {
    const content = [
      JSON.stringify({ display: "hi", timestamp: 1, project: "/Users/me/a", sessionId: "id-1" }),
      JSON.stringify({ display: "yo", timestamp: 2, project: "/Users/me/b", sessionId: "id-1" }),
      JSON.stringify({ display: "ok", timestamp: 3, project: "/Users/me/c", sessionId: "id-2" }),
      "broken line",
      JSON.stringify({ nope: true }),
    ].join("\n");
    const map = parseClaudeHistoryIndex(content);
    assert.equal(map.get("id-1"), "/Users/me/a"); // 首条优先
    assert.equal(map.get("id-2"), "/Users/me/c");
    assert.equal(map.size, 2);
  });

  it("findClaudeSessionFiles/scanClaudeSessions：过滤非会话文件、history cwd 兜底、损坏文件跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-projects-"));
    try {
      const projDir = join(root, "-Users-me-Workspace-demo");
      await mkdir(projDir, { recursive: true });
      await writeFile(join(projDir, `${SID}.jsonl`), fixture, "utf8");
      // 非会话文件/目录：必须被排除
      await writeFile(join(projDir, "skill-injections.jsonl"), "{}\n", "utf8");
      await writeFile(join(projDir, "memory.jsonl"), "{}\n", "utf8");
      await mkdir(join(projDir, "memory"), { recursive: true });
      await writeFile(join(projDir, "memory", `${SID}.jsonl`), fixture, "utf8"); // 子目录不扫
      // cwd 缺失的会话：靠 history.jsonl 兜底
      const noCwdLines = [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, uuid: "u1", timestamp: "2026-09-29T11:00:00.000Z", sessionId: "id-hist" }),
      ];
      await writeFile(join(projDir, "00000000-0000-4000-8000-000000000000.jsonl"), noCwdLines.join("\n"), "utf8");
      // 损坏文件：不影响其它会话
      await writeFile(join(projDir, "11111111-1111-4111-8111-111111111111.jsonl"), "", "utf8");

      const files = await findClaudeSessionFiles(root);
      assert.equal(files.length, 3, `应找到 3 个会话文件，实际 ${JSON.stringify(files)}`);

      const history = parseClaudeHistoryIndex(
        JSON.stringify({ display: "hi", timestamp: 1, project: "/Users/me/history-cwd", sessionId: "id-hist" }),
      );
      const sessions = await scanClaudeSessions(root, history, { statusOf: () => "idle" });
      assert.equal(sessions.length, 3);
      const withCwd = sessions.find((s) => s.id === SID);
      assert.ok(withCwd);
      assert.equal(withCwd.source, "claude");
      assert.equal(withCwd.cwd, CWD);
      const fromHistory = sessions.find((s) => s.id === "id-hist");
      assert.ok(fromHistory);
      assert.equal(fromHistory.cwd, "/Users/me/history-cwd");
      // updatedAt 倒序
      for (let i = 1; i < sessions.length; i += 1) {
        assert.ok(Date.parse(sessions[i - 1].updatedAt) >= Date.parse(sessions[i].updatedAt));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scanClaudeSessions：目录不存在返回空数组（不是错误）", async () => {
    const sessions = await scanClaudeSessions(join(tmpdir(), "definitely-not-exists-claude"), new Map());
    assert.deepEqual(sessions, []);
  });
});

describe("claude transcript: image block → MessageDto.images", () => {
  const B64 = "aGVsbG8=";

  it("纯图 user 行：占位文本 + images；文本+图：text + images", () => {
    const lines = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: B64 } }],
        },
        uuid: "u-img1",
        timestamp: "2026-09-29T09:17:33.525Z",
        cwd: CWD,
        sessionId: SID,
      }),
      JSON.stringify({
        parentUuid: "u-img1",
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "看这个截图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: B64 } },
          ],
        },
        uuid: "u-img2",
        timestamp: "2026-09-29T09:18:33.525Z",
        cwd: CWD,
        sessionId: SID,
      }),
    ];
    const parsed = parseClaudeTranscript(lines.join("\n"));
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].text, "[image]");
    assert.deepEqual(parsed.messages[0].images, [{ url: `data:image/jpeg;base64,${B64}`, alt: null }]);
    assert.equal(parsed.messages[1].text, "看这个截图");
    assert.deepEqual(parsed.messages[1].images, [{ url: `data:image/png;base64,${B64}`, alt: null }]);
  });

  it("无图消息不带 images 字段（向后兼容）", () => {
    const parsed = parseClaudeTranscript(fixtureLines.join("\n"));
    for (const m of parsed.messages) {
      assert.equal(m.images, undefined, m.id);
    }
  });
});
