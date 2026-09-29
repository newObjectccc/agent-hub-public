/**
 * 会话 JSONL 列表解析单测（临时目录伪造 session 文件）。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildMessages,
  buildSessionSummary,
  contentToImages,
  encodeCwdDirName,
  hasSubAgentPreambleMarker,
  isSubAgentName,
  isSubAgentSession,
  MAX_MESSAGE_IMAGES,  parseSessionJsonl,
  scanSessions,
  selectActiveBranch,
  sessionFileName,
  truncateText,
  LAST_MESSAGE_LIMIT,
} from "../sessions/scan.js";

let root: string;

const header = { type: "session", version: 3, id: "sess-0001", timestamp: "2026-02-18T10:00:00.000Z", cwd: "/Users/me/Workspace/demo" };

const longText = "x".repeat(200);

const entriesLines = [
  // user 消息
  JSON.stringify({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-02-18T10:00:01.000Z",
    message: { role: "user", content: "帮我检查周报 KPI 口径", timestamp: 1733234401000 },
  }),
  // assistant 消息（带 toolCall）
  JSON.stringify({
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-02-18T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "好的，我先查 ETL 水位" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1733234402000,
    },
  }),
  // toolResult 折叠进 assistant
  JSON.stringify({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-02-18T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "total 0" }], isError: false, timestamp: 1733234403000 },
  }),
  // 分支：从 e1 分出（弃用 e2/e3 路径的另一分支为 leaf）
  JSON.stringify({
    type: "message",
    id: "e4",
    parentId: "e1",
    timestamp: "2026-02-18T10:05:00.000Z",
    message: { role: "user", content: longText, timestamp: 1733234700000 },
  }),
  JSON.stringify({
    type: "message",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-02-18T10:05:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: longText }],
      timestamp: 1733234701000,
    },
  }),
  JSON.stringify({ type: "session_info", id: "e6", parentId: "e5", timestamp: "2026-02-18T10:06:00.000Z", name: "pi-seksun-KPI" }),
];

describe("scan: JSONL 解析与列表项", () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-scan-"));
    const dir = join(root, encodeCwdDirName("/Users/me/Workspace/demo"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, sessionFileName("2026-02-18T10:00:00.000Z", "sess-0001")),
      [JSON.stringify(header), ...entriesLines].join("\n") + "\n",
    );
    // 第二个会话（更旧），验证 updatedAt 倒序
    const dir2 = join(root, encodeCwdDirName("/Users/me/Workspace/other"));
    await mkdir(dir2, { recursive: true });
    await writeFile(
      join(dir2, sessionFileName("2026-02-17T09:00:00.000Z", "sess-0002")),
      [
        JSON.stringify({ type: "session", version: 3, id: "sess-0002", timestamp: "2026-02-17T09:00:00.000Z", cwd: "/Users/me/Workspace/other" }),
        JSON.stringify({
          type: "message",
          id: "f1",
          parentId: null,
          timestamp: "2026-02-17T09:00:01.000Z",
          message: { role: "user", content: "旧会话", timestamp: 1733220001000 },
        }),
      ].join("\n") + "\n",
    );
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("encodeCwdDirName/sessionFileName 与 pi 命名规则一致", () => {
    assert.equal(encodeCwdDirName("/Users/me/Workspace/demo"), "--Users-me-Workspace-demo--");
    assert.equal(sessionFileName("2026-02-18T10:00:00.000Z", "abc"), "2026-02-18T10-00-00-000Z_abc.jsonl");
  });

  it("parseSessionJsonl 解析 header 与 entries，跳过损坏行", () => {
    const parsed = parseSessionJsonl(`${JSON.stringify(header)}\nnot-json\n${entriesLines[0]}\n`);
    assert.equal(parsed.header?.id, "sess-0001");
    assert.equal(parsed.entries.length, 1);
  });

  it("scanSessions 扫描全部 cwd 分组并按 updatedAt 倒序", async () => {
    const items = await scanSessions(root);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, "sess-0001");
    assert.equal(items[1].id, "sess-0002");
    assert.equal(items[0].status, "idle");
  });

  it("列表项字段：name/messageCount/lastUserMessage/lastAssistantMessage（120 截断）", async () => {
    const items = await scanSessions(root);
    const item = items[0];
    assert.equal(item.name, "pi-seksun-KPI");
    assert.equal(item.cwd, "/Users/me/Workspace/demo");
    assert.equal(item.messageCount, 5);
    // active branch 是 e1 → e4 → e5（leaf 为最后一条 entry e6，路径 e1→e4→e5→e6）
    assert.equal(item.lastUserMessage, truncateText(longText, LAST_MESSAGE_LIMIT));
    assert.equal(item.lastUserMessage.length, LAST_MESSAGE_LIMIT + 1); // 120 字 + 省略号
    assert.equal(item.lastAssistantMessage, truncateText(longText, LAST_MESSAGE_LIMIT));
    assert.ok(item.sessionFile.endsWith(".jsonl"));
    assert.ok(!Number.isNaN(Date.parse(item.updatedAt)));
  });

  it("selectActiveBranch 只取活跃叶到根的路径", () => {
    const { entries } = parseSessionJsonl([JSON.stringify(header), ...entriesLines].join("\n"));
    const branch = selectActiveBranch(entries);
    const ids = branch.map((e) => e.id);
    // leaf 是最后一条 entry（e6），路径 e1 → e4 → e5 → e6；e2/e3 是被弃分支
    assert.deepEqual(ids, ["e1", "e4", "e5", "e6"]);
  });

  it("buildMessages：toolResult 折叠进 assistant 的 toolCalls", () => {
    const { entries } = parseSessionJsonl([JSON.stringify(header), ...entriesLines.slice(0, 3)].join("\n"));
    const messages = buildMessages(selectActiveBranch(entries));
    assert.equal(messages.length, 2);
    const [user, assistant] = messages;
    assert.equal(user.role, "user");
    assert.equal(user.text, "帮我检查周报 KPI 口径");
    assert.equal(user.timestamp, 1733234401000);
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.toolCalls.length, 1);
    assert.equal(assistant.toolCalls[0].name, "bash");
    assert.equal(assistant.toolCalls[0].summary, "ls -la");
    assert.equal(assistant.toolCalls[0].status, "done");
    assert.equal(assistant.toolCalls[0].resultPreview, "total 0");
  });

  it("buildSessionSummary：无 session_info 时 name 为 null", () => {
    const parsed = parseSessionJsonl(
      [JSON.stringify(header), entriesLines[0]].join("\n"),
    );
    const summary = buildSessionSummary("/tmp/x.jsonl", parsed, Date.parse("2026-02-18T10:00:01.000Z"));
    assert.ok(summary);
    assert.equal(summary.name, null);
    assert.equal(summary.lastAssistantMessage, null);
  });
});

describe("scan: 确定性排序 tiebreaker（AC3-a）", () => {
  it("updatedAt 相同的会话无论输入顺序输出恒定（id 升序）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-sort-"));
    try {
      const ts = "2026-02-18T12:00:00.000Z";
      for (const id of ["zz", "aa", "mm"]) {
        await writeFile(
          join(dir, `${id}.jsonl`),
          [
            JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/tmp/x" }),
            JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "hi" } }),
          ].join("\n"),
          "utf8",
        );
      }
      const a = await scanSessions(dir);
      const b = await scanSessions(dir);
      assert.deepEqual(a.map((x) => x.id), ["aa", "mm", "zz"]);
      assert.deepEqual(b.map((x) => x.id), a.map((x) => x.id), "两次扫描顺序必须一致");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scan: 子代理会话识别（isSubAgent）", () => {
  it("会话名匹配 `<type>#<id>` 规则", () => {
    assert.equal(isSubAgentName("developer#abc123"), true);
    assert.equal(isSubAgentName("developer#e51f8eef"), true);
    assert.equal(isSubAgentName("acceptance-reviewer#f81d33aa"), true);
    assert.equal(isSubAgentName("Acceptance-Reviewer#f81d33aa"), false); // 大写不命中
    assert.equal(isSubAgentName("developer#XYZ123"), false); // 后缀非 hex
    assert.equal(isSubAgentName("pi-seksun-KPI"), false);
    assert.equal(isSubAgentName("R3-sys"), false);
    assert.equal(isSubAgentName(null), false);
  });

  it("入口消息含 pi-subagents 派生特征（无命名也命中）", () => {
    const entries = [
      {
        type: "message",
        id: "m0",
        parentId: null,
        timestamp: "2026-02-18T10:00:00.000Z",
        message: {
          role: "system",
          content: "",
          sections: { preamble: "...\n<sub_agent_context>\nYou are operating as a sub-agent invoked to handle a specific task.\n</sub_agent_context>\n<active_agent name=\"developer\"/>\n..." },
        },
      },
      { type: "message", id: "m1", parentId: "m0", timestamp: "2026-02-18T10:00:01.000Z", message: { role: "user", content: "实现 issue X" } },
    ];
    assert.equal(isSubAgentSession(null, entries), true);
  });

  it("主会话（普通命名 + 无派生特征）不命中", () => {
    const entries = [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-02-18T10:00:01.000Z", message: { role: "user", content: "帮我看看构建" } },
    ];
    assert.equal(isSubAgentSession("pi-seksun-KPI", entries), false);
    assert.equal(isSubAgentSession(null, entries), false);
  });

  it("buildSessionSummary 输出 isSubAgent（命名规则 + 特征两种来源）", () => {
    const named = buildSessionSummary(
      "/tmp/a.jsonl",
      parseSessionJsonl(
        [
          JSON.stringify({ type: "session", version: 3, id: "sub-1", timestamp: "2026-02-18T10:00:00.000Z", cwd: "/tmp/ws" }),
          JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-02-18T10:00:01.000Z", name: "developer#abc123" }),
          JSON.stringify({ type: "message", id: "m1", parentId: "n1", timestamp: "2026-02-18T10:00:02.000Z", message: { role: "user", content: "hi" } }),
        ].join("\n"),
      ),
      Date.parse("2026-02-18T10:00:02.000Z"),
    );
    assert.equal(named?.name, "developer#abc123");
    assert.equal(named?.isSubAgent, true);

    const main = buildSessionSummary(
      "/tmp/b.jsonl",
      parseSessionJsonl(
        [
          JSON.stringify({ type: "session", version: 3, id: "main-1", timestamp: "2026-02-18T10:00:00.000Z", cwd: "/tmp/ws" }),
          JSON.stringify({ type: "session_info", id: "n2", parentId: null, timestamp: "2026-02-18T10:00:01.000Z", name: "pi-seksun-KPI" }),
        ].join("\n"),
      ),
      Date.parse("2026-02-18T10:00:02.000Z"),
    );
    assert.equal(main?.isSubAgent, false);
  });
});

describe("AC4 零误检：主会话内容提及不算子代理", () => {
  const systemPreamble = { type: "message", id: "s0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "system", content: "", sections: { preamble: "You are an expert coding assistant operating inside pi, a coding agent harness." } } };
  const mkUser = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text } });

  it("主会话消息正文提及 pi-subagents / 标记字符串 → isSubAgent=false", () => {
    const entries = [
      systemPreamble,
      mkUser("u1", "https://github.com/tintinweb/pi-subagents 这个库，我安装了这个插件"),
      mkUser("u2", '引述文档：<sub_agent_context> 和 <active_agent name="x"> 是什么'),
    ];
    assert.equal(isSubAgentSession(null, entries as never), false);
  });

  it("system preamble 含结构标记 → isSubAgent=true", () => {
    const entries = [
      { type: "message", id: "s0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "system", content: "", sections: { preamble: "<sub_agent_context>\n<active_agent name=\"developer\">" } } },
    ];
    assert.equal(isSubAgentSession(null, entries as never), true);
  });

  it("命名规则 <type>#<hex> 仍判定为子代理", () => {
    assert.equal(isSubAgentName("developer#abc123"), true);
    assert.equal(isSubAgentName("pi-seksun-KPI"), false);
    assert.equal(hasSubAgentPreambleMarker("普通 preamble"), false);
    assert.equal(hasSubAgentPreambleMarker("x <active_agent name=\"a\"> y"), true);
});
});

describe("scan: 图片内容块（ImageContent → MessageDto.images）", () => {
  const base64Block = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };

  it("contentToImages：base64→data URL、url source、块内 url、非 image 跳过", () => {
    const images = contentToImages([
      { type: "text", text: "看图" },
      base64Block,
      { type: "image", source: { type: "url", url: "https://x.test/a.png" } },
      { type: "image", url: "https://x.test/b.png" },
      { type: "tool_use", id: "t1" },
    ]);
    assert.deepEqual(images, [
      { url: "data:image/png;base64,aGVsbG8=", alt: null },
      { url: "https://x.test/a.png", alt: null },
      { url: "https://x.test/b.png", alt: null },
    ]);
  });

  it("contentToImages：无图返回 null；超上限截断到 MAX_MESSAGE_IMAGES", () => {
    assert.equal(contentToImages("文本"), null);
    assert.equal(contentToImages([{ type: "text", text: "x" }]), null);
    const many = Array.from({ length: MAX_MESSAGE_IMAGES + 3 }, () => base64Block);
    assert.equal(contentToImages(many)?.length, MAX_MESSAGE_IMAGES);
  });

  it("buildMessages：user/assistant 消息附 images，text 保持纯文本", () => {
    const parsed = parseSessionJsonl(
      [
        JSON.stringify(header),
        JSON.stringify({
          type: "message",
          id: "img1",
          parentId: null,
          timestamp: "2026-02-18T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "看这个图" }, base64Block], timestamp: 1733234401000 },
        }),
        JSON.stringify({
          type: "message",
          id: "img2",
          parentId: "img1",
          timestamp: "2026-02-18T10:00:02.000Z",
          message: { role: "assistant", content: [{ type: "image", source: { type: "url", url: "https://x.test/c.png" } }], timestamp: 1733234402000 },
        }),
      ].join("\n") + "\n",
    );
    const messages = buildMessages(parsed.entries);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, "看这个图");
    assert.deepEqual(messages[0].images, [{ url: "data:image/png;base64,aGVsbG8=", alt: null }]);
    assert.deepEqual(messages[1].images, [{ url: "https://x.test/c.png", alt: null }]);
    // 无图消息字段缺省（向后兼容）
    assert.equal(messages[0].thinking, null);  });
});
