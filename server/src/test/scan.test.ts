/**
 * 会话 JSONL 列表解析单测（临时目录伪造 session 文件）。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildInsight,
  buildMessages,
  buildSessionSummary,
  contentToImages,
  encodeCwdDirName,
  hasSubAgentPreambleMarker,
  isSubAgentName,
  isSubAgentSession,
  parentSessionIdFromPath,
  MAX_MESSAGE_IMAGES,  parseSessionJsonl,
  resetSessionCaches,
  scanSessionInsights,
  scanSessions,
  scanSubAgentLineage,
  selectActiveBranch,
  sessionCacheStats,
  sessionFileName,
  truncateText,
  LAST_MESSAGE_LIMIT,
} from "../sessions/scan.js";
import { countSettledRuns, countTodayMessages, startOfDay, startOfWeek } from "../dashboard.js";
import type { MessageDto, SessionListItem } from "../types.js";

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
  JSON.stringify({ type: "session_info", id: "e6", parentId: "e5", timestamp: "2026-02-18T10:06:00.000Z", name: "pi-report-KPI" }),
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
    assert.equal(item.name, "pi-report-KPI");
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
    assert.equal(isSubAgentName("pi-report-KPI"), false);
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
    assert.equal(isSubAgentSession("pi-report-KPI", entries), false);
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
          JSON.stringify({ type: "session_info", id: "n2", parentId: null, timestamp: "2026-02-18T10:00:01.000Z", name: "pi-report-KPI" }),
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
    assert.equal(isSubAgentName("pi-report-KPI"), false);
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

describe("scan: 父子关联（parentSessionId）", () => {
  it("parentSessionIdFromPath：解析 pi header.parentSession 文件名末段", () => {
    assert.equal(
      parentSessionIdFromPath(
        "/Users/me/.pi/agent/sessions/--Users-me-x--/2026-09-29T08-08-16-291Z_01a0ec35-12a2-7707-9635-73fe933b060e.jsonl",
      ),
      "01a0ec35-12a2-7707-9635-73fe933b060e",
    );
    // Windows 路径分隔符同样兼容
    assert.equal(parentSessionIdFromPath("C:\\x\\2026-01-01T00-00-00-000Z_abc123.jsonl"), "abc123");
  });

  it("parentSessionIdFromPath：无效输入返回 null（不抛错）", () => {
    assert.equal(parentSessionIdFromPath(undefined), null);
    assert.equal(parentSessionIdFromPath(null), null);
    assert.equal(parentSessionIdFromPath(""), null);
    assert.equal(parentSessionIdFromPath("/tmp/无文件名规律.txt"), null);
    assert.equal(parentSessionIdFromPath("/tmp/x.jsonl"), null);
  });

  it("buildSessionSummary：header.parentSession 注入 parentSessionId；缺失为 null", () => {
    const childHeader = {
      ...header,
      id: "sess-child",
      parentSession: "/Users/me/.pi/agent/sessions/--x--/2026-02-18T09-00-00-000Z_sess-0001.jsonl",
    };
    const child = buildSessionSummary(
      "/tmp/child.jsonl",
      parseSessionJsonl([JSON.stringify(childHeader), entriesLines[0]].join("\n")),
      Date.parse("2026-02-18T10:00:01.000Z"),
    );
    assert.equal(child?.parentSessionId, "sess-0001");

    const orphan = buildSessionSummary(
      "/tmp/x.jsonl",
      parseSessionJsonl([JSON.stringify(header), entriesLines[0]].join("\n")),
      Date.parse("2026-02-18T10:00:01.000Z"),
    );
    assert.equal(orphan?.parentSessionId, null);
  });

  it("scanSessions：子代理会话带 parentSessionId 且父子同批可见（树形分组基础）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-parent-"));
    try {
      const ts = "2026-02-18T12:00:00.000Z";
      // parentSession 指向真实命名格式的父文件（`<timestamp>_<sessionId>.jsonl`）
      const parentFile = join(dir, "2026-02-18T11-00-00-000Z_p-1.jsonl");
      await writeFile(
        parentFile,
        [
          JSON.stringify({ type: "session", version: 3, id: "p-1", timestamp: ts, cwd: "/tmp/x" }),
          JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "hi" } }),
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(dir, "child.jsonl"),
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "c-1",
            timestamp: ts,
            cwd: "/tmp/x",
            parentSession: parentFile,
          }),
          JSON.stringify({ type: "session_info", id: "si", parentId: null, timestamp: ts, name: "developer#abc123" }),
          JSON.stringify({ type: "message", id: "m2", parentId: null, timestamp: ts, message: { role: "user", content: "sub" } }),
        ].join("\n"),
        "utf8",
      );
      const items = await scanSessions(dir);
      const child = items.find((x) => x.id === "c-1");
      assert.ok(child);
      assert.equal(child.parentSessionId, "p-1");
      assert.equal(child.isSubAgent, true);
      const parent = items.find((x) => x.id === "p-1");
      assert.equal(parent?.parentSessionId, null);
      assert.equal(parent?.isSubAgent, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scan: 洞察计数与 per-file 增量缓存（AC2/AC3/AC4 基准）", () => {
  it("buildInsight 计数与 dashboard 口径逐字一致；Insight 不携带全量 messages", () => {
    const ts = (min: number): number => Date.parse("2026-02-18T12:00:00.000Z") - min * 60_000;
    const messages: MessageDto[] = [
      { id: "u1", role: "user", timestamp: ts(30), text: "一", toolCalls: [] },
      { id: "a1", role: "assistant", timestamp: ts(29), text: "好", toolCalls: [] },
      { id: "u2", role: "user", timestamp: ts(10), text: "二", toolCalls: [] },
      { id: "a2", role: "assistant", timestamp: ts(29 + 20), text: "好", toolCalls: [] },
      { id: "a3", role: "assistant", timestamp: ts(8), text: "补充", toolCalls: [] },
    ];
    const summary: SessionListItem = {
      id: "ins-1",
      name: null,
      cwd: "/tmp/x",
      updatedAt: new Date(ts(8)).toISOString(),
      messageCount: messages.length,
      status: "idle",
      lastUserMessage: "二",
      lastAssistantMessage: "补充",
      sessionFile: "/tmp/ins-1.jsonl",
      isSubAgent: false,
      source: "pi",
    };
    const insight = buildInsight(summary, messages);
    assert.ok(!("messages" in insight), "Insight 不再携带全量 messages（防全语料驻留）");
    // 口径等价：与旧实现（derive 时逐条按 now 过滤）逐字一致（同窗基准：derive-now = 锚点）
    const now = insight.counts.anchorMs;
    const window = { dayStart: startOfDay(now), dayEnd: now + 1, running: false };
    assert.equal(insight.counts.settledToday, countSettledRuns(messages, window));
    assert.equal(insight.counts.todayMessages, countTodayMessages(messages, window));
    assert.equal(
      insight.counts.settledThisWeek,
      countSettledRuns(messages, { dayStart: startOfWeek(now), dayEnd: now + 1, running: false }),
    );
    assert.equal(
      insight.counts.weekMessages,
      countTodayMessages(messages, { dayStart: startOfWeek(now), dayEnd: now + 1 }),
    );
    // 两轮 run（a1 后随 user；a3 是末条且未运行）
    assert.equal(insight.counts.settledToday, 2);
    assert.equal(insight.counts.todayMessages, 5);
    assert.equal(insight.counts.activeDays.length, 1);
    // running 口径：末条 assistant 不算 settled（与 countSettledRuns 的 window.running 同源）
    const runningInsight = buildInsight({ ...summary, status: "running" }, messages);
    assert.equal(runningInsight.counts.settledToday, 1);
    assert.equal(
      runningInsight.counts.settledToday,
      countSettledRuns(messages, { ...window, running: true }),
    );
  });

  it("per-file 增量：第二次扫描零读盘零 parse，变更文件只重读自身（AC2）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-inc-"));
    try {
      const fileOf = (id: string, extra = ""): string =>
        [
          JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-02-18T12:00:00.000Z", cwd: "/tmp/x" }),
          JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-02-18T12:00:01.000Z", message: { role: "user", content: `hi ${extra}` } }),
        ].join("\n") + "\n";
      for (const id of ["inc-a", "inc-b", "inc-c"]) {
        await writeFile(join(dir, `${id}.jsonl`), fileOf(id), "utf8");
      }
      resetSessionCaches();
      await scanSessions(dir);
      const cold = sessionCacheStats();
      assert.equal(cold.fileReads, 3, "冷扫描每文件读盘一次");
      assert.equal(cold.fileParses, 3);
      await scanSessionInsights(dir);
      await scanSessions(dir);
      await scanSessionInsights(dir);
      const hot = sessionCacheStats();
      assert.equal(hot.fileReads, 3, "第二次起扫描零读盘（列表/洞察共享解析缓存）");
      assert.equal(hot.fileParses, 3, "第二次起零 parse");
      // 变更一个文件 → 只重读自身
      await writeFile(join(dir, "inc-b.jsonl"), fileOf("inc-b", "v2"), "utf8");
      await scanSessions(dir);
      assert.equal(sessionCacheStats().fileReads, 4, "仅变更文件重读");
      // 删除文件 → 快照清账，后续扫描不再累积
      await rm(join(dir, "inc-c.jsonl"));
      await scanSessions(dir);
      assert.equal(sessionCacheStats().fileReads, 4, "删除文件不重读");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scanSubAgentLineage：TTL 内重复调用零读盘，新文件立即可见（AC3）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-lin-"));
    try {
      const childLine = (id: string, name: string): string =>
        [
          JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x", parentSession: "parent-x" }),
          JSON.stringify({ type: "session_info", name, timestamp: "2026-01-01T00:00:00.000Z" }),
        ].join("\n") + "\n";
      await writeFile(join(dir, "c1.jsonl"), childLine("child-1", "developer#aaaa01"), "utf8");
      resetSessionCaches();
      let lineage = await scanSubAgentLineage(dir);
      assert.equal(sessionCacheStats().fileReads, 1);
      assert.equal(lineage.length, 1);
      await scanSubAgentLineage(dir);
      await scanSubAgentLineage(dir);
      assert.equal(sessionCacheStats().fileReads, 1, "TTL 内重复调用零读盘（跨连接共享同一次扫描）");
      // 新写入静态子会话立即可见（名单校验，不等 TTL）
      await writeFile(join(dir, "c2.jsonl"), childLine("child-2", "developer#bbbb02"), "utf8");
      lineage = await scanSubAgentLineage(dir);
      assert.ok(lineage.some((l) => l.id === "child-2"), "新文件立即可见");
      assert.equal(sessionCacheStats().fileReads, 2, "只读新文件");
      // TTL=0（每次重扫）下未变文件也不重读（per-file mtime+size 复用）
      await scanSubAgentLineage(dir, { ttlMs: 0 });
      await scanSubAgentLineage(dir, { ttlMs: 0 });
      assert.equal(sessionCacheStats().fileReads, 2, "重扫不重读未变文件");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
