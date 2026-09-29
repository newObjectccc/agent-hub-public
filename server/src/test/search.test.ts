/**
 * 全局搜索单测：摘要生成/截断/高亮标记、active branch 索引口径、
 * SearchService 缓存与失效（TTL + invalidate）。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  indexSessionFile,
  makeSnippet,
  SearchService,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  SNIPPET_RADIUS,
} from "../sessions/search.js";

const header = { type: "session", version: 3, id: "sess-0001", timestamp: "2026-02-18T10:00:00.000Z", cwd: "/Users/me/Workspace/demo" };

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

/** 含分叉的会话：e2/e3 为弃用分支，e4/e5 为活跃分支（leaf=e5） */
const forkedEntries = [
  line({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-02-18T10:00:01.000Z",
    message: { role: "user", content: "帮我检查周报 KPI 口径", timestamp: 1733234401000 },
  }),
  line({
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-02-18T10:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "弃用分支里的 KPI 结论" }], timestamp: 1733234402000 },
  }),
  line({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-02-18T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call_x", toolName: "bash", content: [{ type: "text", text: "KPI tool output" }], isError: false, timestamp: 1733234403000 },
  }),
  line({
    type: "message",
    id: "e4",
    parentId: "e1",
    timestamp: "2026-02-18T10:05:00.000Z",
    message: { role: "user", content: "换算 kpi 完成率时用小写再搜一次", timestamp: 1733234700000 },
  }),
  line({
    type: "message",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-02-18T10:05:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "活跃分支结论：KPI 完成率 98.2%" }], timestamp: 1733234701000 },
  }),
];

describe("search: makeSnippet 摘要截断与高亮标记", () => {
  it("命中居中：前后各 ~SNIPPET_RADIUS 字符，命中以 [[...]] 包裹", () => {
    const text = `${"a".repeat(100)}命中词${"b".repeat(100)}`;
    const snippet = makeSnippet(text, "命中词");
    assert.ok(snippet.startsWith("…"));
    assert.ok(snippet.endsWith("…"));
    assert.ok(snippet.includes(`${SNIPPET_OPEN}命中词${SNIPPET_CLOSE}`));
    // 命中前 60 + 命中 + 命中后 60
    assert.equal(snippet.length, 1 + SNIPPET_RADIUS + `${SNIPPET_OPEN}命中词${SNIPPET_CLOSE}`.length + SNIPPET_RADIUS + 1);
  });

  it("大小写不敏感，且窗口内多处命中全部标记", () => {
    const snippet = makeSnippet("KPI 与 kpi 是同一口径，Kpi 也是", "kpi");
    assert.equal(snippet.split(SNIPPET_OPEN).length - 1, 3);
    assert.ok(snippet.includes(`${SNIPPET_OPEN}KPI${SNIPPET_CLOSE}`));
    assert.ok(snippet.includes(`${SNIPPET_OPEN}kpi${SNIPPET_CLOSE}`));
    assert.ok(snippet.includes(`${SNIPPET_OPEN}Kpi${SNIPPET_CLOSE}`));
  });

  it("命中靠文本头部/尾部时不加对应省略号", () => {
    const head = makeSnippet("开头就命中其余内容", "开头");
    assert.ok(head.startsWith(`${SNIPPET_OPEN}开头${SNIPPET_CLOSE}`));
    assert.ok(!head.startsWith("…"));
    const tail = makeSnippet("前面的内容结尾命中", "结尾命中");
    assert.ok(tail.endsWith(`${SNIPPET_OPEN}结尾命中${SNIPPET_CLOSE}`));
    assert.ok(!tail.endsWith("…"));
  });

  it("短文本不截断（无省略号），长文本只保留窗口", () => {
    const short = makeSnippet("短文本命中", "命中");
    assert.equal(short, `短文本${SNIPPET_OPEN}命中${SNIPPET_CLOSE}`);
    const long = makeSnippet(`x${"a".repeat(500)}命中${"b".repeat(500)}y`, "命中");
    assert.ok(long.startsWith("…"));
    assert.ok(long.endsWith("…"));
    assert.ok(long.length < 200);
  });

  it("空关键词/未命中时兜底返回头部截断（不抛错）", () => {
    assert.ok(makeSnippet("abc", "").length > 0);
    assert.ok(makeSnippet("abc", "zzz").length > 0);
  });
});

describe("search: indexSessionFile 索引口径（active branch + 会话名）", () => {
  it("只索引 active branch 消息文本，弃用分支与 toolResult 不进索引", () => {
    const content = [line(header), line({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-02-18T10:00:00.500Z", name: "pi-demo" }), ...forkedEntries].join("\n");
    const index = indexSessionFile("/tmp/x.jsonl", content, 1733234701000);
    assert.deepEqual(index.map((e) => e.messageId), ["e1", "e4", "e5"]);
    assert.ok(index.every((e) => e.sessionId === "sess-0001" && e.sessionName === "pi-demo"));
    assert.ok(!index.some((e) => e.text.includes("弃用分支")));
  });

  it("无 header 的文件不进索引", () => {
    const index = indexSessionFile("/tmp/y.jsonl", line(forkedEntries[0] ? JSON.parse(forkedEntries[0]) : {}), 42);
    assert.equal(index.length, 0);
  });

  it("消息时间戳缺失时用文件 mtime 兜底（排序稳定）", () => {
    const content = [
      line(header),
      line({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "无时间戳消息" } }),
    ].join("\n");
    const index = indexSessionFile("/tmp/z.jsonl", content, 1733220001000);
    assert.equal(index.length, 1);
    assert.equal(index[0].timestamp, 1733220001000);
  });
});

describe("search: SearchService 匹配/排序/上限/缓存失效", () => {
  let root: string;
  let service: SearchService;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-search-"));
    const dir = join(root, "--Users-me-Workspace-demo--");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-02-18T10-00-00-000Z_sess-0001.jsonl"), [line(header), ...forkedEntries].join("\n") + "\n");
    await writeFile(
      join(dir, "2026-02-17T09-00-00-000Z_sess-0002.jsonl"),
      [
        line({ type: "session", version: 3, id: "sess-0002", timestamp: "2026-02-17T09:00:00.000Z", cwd: "/Users/me/Workspace/other" }),
        line({
          type: "message",
          id: "f1",
          parentId: null,
          timestamp: "2026-02-17T09:00:01.000Z",
          message: { role: "user", content: "旧会话也提到 KPI 水位", timestamp: 1733220001000 },
        }),
      ].join("\n") + "\n",
    );
    service = new SearchService(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("跨会话命中、按时间倒序、大小写不敏感", async () => {
    const results = await service.search("kpi");
    const ids = results.map((r) => r.messageId);
    // 时间倒序：e5(1733234701000) > e4(1733234700000) > e1(1733234401000) > f1(1733220001000)
    assert.deepEqual(ids, ["e5", "e4", "e1", "f1"]);
    assert.equal(results[0].sessionName, null);
    assert.ok(results[0].snippet.includes(`${SNIPPET_OPEN}`));
    assert.equal(results[3].sessionId, "sess-0002");
  });

  it("limit 钳制上限 100（超发也只回 100）", async () => {
    const results = await service.search("kpi", 5000);
    assert.ok(results.length <= 100);
    const one = await service.search("kpi", 1);
    assert.equal(one.length, 1);
  });

  it("空关键词返回 []", async () => {
    assert.deepEqual(await service.search("   "), []);
  });

  it("缓存：TTL 内复用旧索引，invalidate() 后看到新内容，TTL=0 每次重建", async () => {
    assert.equal((await service.search("新关键词后加")).length, 0);
    const dir = join(root, "--Users-me-Workspace-demo--");
    await writeFile(
      join(dir, "2026-02-18T11-00-00-000Z_sess-0003.jsonl"),
      [
        line({ type: "session", version: 3, id: "sess-0003", timestamp: "2026-02-18T11:00:00.000Z", cwd: "/Users/me/Workspace/demo" }),
        line({
          type: "message",
          id: "g1",
          parentId: null,
          timestamp: "2026-02-18T11:00:01.000Z",
          message: { role: "user", content: "新关键词后加的会话", timestamp: 1733238001000 },
        }),
      ].join("\n") + "\n",
    );
    // TTL 内：仍是旧缓存
    assert.equal((await service.search("新关键词后加")).length, 0);
    // invalidate（presence 变更回调）→ 重建后可见
    service.invalidate();
    const fresh = await service.search("新关键词后加");
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].sessionId, "sess-0003");

    // TTL=0：不依赖 invalidate 也能看到后续变更
    const eager = new SearchService(root, 0);
    assert.equal((await eager.search("临时字段")).length, 0);
    await writeFile(
      join(dir, "2026-02-18T12-00-00-000Z_sess-0004.jsonl"),
      [
        line({ type: "session", version: 3, id: "sess-0004", timestamp: "2026-02-18T12:00:00.000Z", cwd: "/Users/me/Workspace/demo" }),
        line({
          type: "message",
          id: "h1",
          parentId: null,
          timestamp: "2026-02-18T12:00:01.000Z",
          message: { role: "user", content: "临时字段测试", timestamp: 1733241601000 },
        }),
      ].join("\n") + "\n",
    );
    assert.equal((await eager.search("临时字段")).length, 1);
  });
});
