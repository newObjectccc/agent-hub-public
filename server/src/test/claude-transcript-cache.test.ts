/**
 * claude 会话清单 per-file 快照缓存单测（性能修复的回归线）。
 *
 * 覆盖：
 * ① 第二遍起零读盘零 parse（cacheStats 断言）
 * ② 文件 mtime / size 变化 → 缓存失效并重新解析
 * ③ 文件被删 → 条目被 prune（且不残留、重建后重读）
 * ④ statusOf 与 history.jsonl 的 cwd 兜底都是运行态：绝不进缓存（同文件不同入参 → 不同结果）
 * ⑤ 两个不同 projectsDir 交替扫描互不清空缓存
 *    （钉死 pi 侧「模块级全局 Map + 按本次扫到的文件集 prune」的互踩缺陷）
 * ⑥ LRU 上限（条目数 / 源字节）淘汰只影响性能，不影响结果正确性
 * ⑦ 单文件损坏不影响其它会话（并发分批后容错语义不变）
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  claudeCacheLimits,
  claudeCacheStats,
  loadClaudeSessionSnapshot,
  parseClaudeHistoryIndex,
  pruneClaudeSessionCache,
  resetClaudeSessionCaches,
  scanClaudeSessions,
  setClaudeCacheLimits,
} from "../adapters/claude-transcript.js";

/** 会话文件名必须是严格 UUID（findClaudeSessionFiles 的过滤口径） */
const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_C = "cccccccc-0000-4000-8000-000000000003";
const SID_NO_CWD = "dddddddd-0000-4000-8000-000000000004";
const PROJECT = "-Users-me-Workspace-demo";
const CWD = "/Users/me/Workspace/demo";

/** 造一份最小合法 transcript（user + assistant，可选 ai-title） */
function transcript(
  sessionId: string,
  opts: { cwd?: string; text?: string; at?: string; atAssistant?: string; name?: string } = {},
): string {
  const at = opts.at ?? "2026-09-29T09:17:33.525Z";
  const cwd = opts.cwd; // undefined → JSON.stringify 省略字段（模拟行内无 cwd，走 history 兜底）
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.text ?? "第一句提问" },
      uuid: "u1",
      timestamp: at,
      cwd,
      sessionId,
    }),
    JSON.stringify({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "第一句回答" }] },
      uuid: "a1",
      // updatedAt 取最后一条有合法 timestamp 的行 → 用它区分不同会话的排序
      timestamp: opts.atAssistant ?? "2026-09-29T09:17:40.000Z",
      cwd,
      sessionId,
    }),
  ];
  if (opts.name !== undefined) {
    lines.push(JSON.stringify({ type: "ai-title", aiTitle: opts.name, sessionId }));
  }
  return `${lines.join("\n")}\n`;
}

/** 写一个会话文件，返回绝对路径 */
async function writeSession(
  root: string,
  sessionId: string,
  content: string,
  project = PROJECT,
): Promise<string> {
  const dir = join(root, project);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, content, "utf8");
  return file;
}

/** 建一个临时 projectsDir（每个用例独立，避免缓存键互撞） */
async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("claude 清单快照缓存：增量命中（AC①）", () => {
  it("第二遍起零读盘零 parse，结果逐字段一致", async () => {
    const root = await makeRoot("claude-cache-hit-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD, text: "会话A" }));
      await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD, text: "会话B" }));
      await writeSession(root, SID_C, transcript(SID_C, { cwd: CWD, text: "会话C" }));

      resetClaudeSessionCaches();
      const cold = await scanClaudeSessions(root);
      const coldStats = claudeCacheStats();
      assert.equal(coldStats.fileReads, 3, "冷扫每文件读盘一次");
      assert.equal(coldStats.fileParses, 3, "冷扫每文件 parse 一次");
      assert.equal(coldStats.cacheHits, 0);
      assert.equal(cold.length, 3);

      // 连扫 4 遍：读盘/parse 计数一律不涨
      let hot = cold;
      for (let i = 0; i < 4; i += 1) hot = await scanClaudeSessions(root);
      const hotStats = claudeCacheStats();
      assert.equal(hotStats.fileReads, 3, "第二遍起零读盘");
      assert.equal(hotStats.fileParses, 3, "第二遍起零 parse");
      assert.equal(hotStats.cacheHits, 12, "4 遍 × 3 文件全部命中快照");
      assert.deepEqual(hot, cold, "热扫结果与冷扫逐字段一致");
      assert.deepEqual(hot.map((s) => s.id).sort(), [SID_A, SID_B, SID_C].sort(), "会话齐全");
      assert.equal(hot.every((s) => s.source === "claude"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("空文件同样进缓存（零消息摘要不反复重读）", async () => {
    const root = await makeRoot("claude-cache-neg-");
    try {
      const dir = join(root, PROJECT);
      await mkdir(dir, { recursive: true });
      // 空文件：无任何行，sessionId 靠文件名 UUID 兜底 → 摘要非 null 但零消息
      const file = join(dir, `${SID_A}.jsonl`);
      await writeFile(file, "", "utf8");

      resetClaudeSessionCaches();
      const first = await loadClaudeSessionSnapshot(root, file);
      assert.ok(first.summary, "文件名 UUID 兜底出 sessionId → 摘要非 null");
      assert.equal(first.summary.id, SID_A);
      assert.equal(first.summary.messageCount, 0);
      assert.equal("status" in first.summary, false, "快照里没有运行态 status");
      assert.equal(claudeCacheStats().fileReads, 1);

      const second = await loadClaudeSessionSnapshot(root, file);
      assert.deepEqual(second.summary, first.summary);
      assert.equal(claudeCacheStats().fileReads, 1, "零消息文件也命中缓存，不反复重读");
      assert.equal(claudeCacheStats().fileParses, 1);
      assert.equal(claudeCacheStats().cacheHits, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：变更失效（AC②）", () => {
  it("size 变化 → 只重读变更文件，新内容立即可见", async () => {
    const root = await makeRoot("claude-cache-size-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD, text: "旧提问" }));
      const fileB = await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD, text: "B提问" }));

      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 2);

      // B 追加一轮对话（size 变大）
      await writeFile(
        fileB,
        `${transcript(SID_B, { cwd: CWD, text: "B提问" })}${JSON.stringify({
          type: "user",
          message: { role: "user", content: "B的第二句" },
          uuid: "u2",
          timestamp: "2026-09-29T10:00:00.000Z",
          cwd: CWD,
          sessionId: SID_B,
        })}\n`,
        "utf8",
      );
      const after = await scanClaudeSessions(root);
      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 3, "仅变更文件重读");
      assert.equal(stats.cacheHits, 1, "未变文件仍命中");
      const b = after.find((s) => s.id === SID_B);
      assert.ok(b);
      assert.equal(b.messageCount, 3, "新消息已计入");
      assert.equal(b.lastUserMessage, "B的第二句", "新内容立即可见");
      assert.equal(b.updatedAt, "2026-09-29T10:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("size 不变、仅 mtime 变化 → 同样失效重 parse", async () => {
    const root = await makeRoot("claude-cache-mtime-");
    try {
      const content = transcript(SID_A, { cwd: CWD, text: "提问" });
      const file = await writeSession(root, SID_A, content);

      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 1);
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 1, "未变时零读盘");

      // 内容原样重写（size 相同），只把 mtime 推到未来 → 必须失效
      await writeFile(file, content, "utf8");
      const future = new Date(Date.now() + 60_000);
      await utimes(file, future, future);
      await scanClaudeSessions(root);
      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 2, "mtime 变化即重读（size 相同也算变更）");
      assert.equal(stats.fileParses, 2, "重读即重 parse");
      assert.equal(stats.cacheHits, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rename（追加 ai-title 行）后名字立即可见", async () => {
    const root = await makeRoot("claude-cache-rename-");
    try {
      const file = await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      resetClaudeSessionCaches();
      const before = await scanClaudeSessions(root);
      assert.equal(before[0].name, null);

      await writeFile(
        file,
        `${transcript(SID_A, { cwd: CWD })}${JSON.stringify({ type: "ai-title", aiTitle: "改名后", sessionId: SID_A })}\n`,
        "utf8",
      );
      const after = await scanClaudeSessions(root);
      assert.equal(after[0].name, "改名后");
      assert.equal(claudeCacheStats().fileReads, 2, "写盘后重读一次");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：删除清账（AC③）", () => {
  it("文件被删 → 条目 prune，后续扫描不再累积、重建后重读", async () => {
    const root = await makeRoot("claude-cache-prune-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      const fileB = await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD }));

      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 2);
      assert.equal(claudeCacheStats().pruned, 0);

      await rm(fileB);
      const after = await scanClaudeSessions(root);
      assert.equal(after.length, 1, "删除的会话不再出现在清单");
      assert.equal(after[0].id, SID_A);
      assert.equal(claudeCacheStats().pruned, 1, "被删文件的快照已清账");
      assert.equal(claudeCacheStats().fileReads, 2, "删除不触发重读");

      // 再扫两遍：不重复 prune、不重读
      await scanClaudeSessions(root);
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().pruned, 1);
      assert.equal(claudeCacheStats().fileReads, 2);
      assert.equal(claudeCacheStats().cacheHits, 3);

      // 同名文件重建（内容不同）：条目已被 prune → 必须重读
      await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD, text: "重建的会话" }));
      const rebuilt = await scanClaudeSessions(root);
      assert.equal(rebuilt.length, 2);
      assert.equal(rebuilt.find((s) => s.id === SID_B)?.lastUserMessage, "重建的会话");
      assert.equal(claudeCacheStats().fileReads, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pruneClaudeSessionCache 只清本目录，未知目录返回 0", async () => {
    const root = await makeRoot("claude-cache-prune2-");
    try {
      const file = await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 1);
      // seen 为空集 → 该目录全部条目清账
      assert.equal(pruneClaudeSessionCache(root, new Set()), 1);
      assert.equal(claudeCacheStats().pruned, 1, "直接调用同样计入 stats.pruned");
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 2, "清账后重读");
      // 不存在的目录：不抛错、不计账
      assert.equal(pruneClaudeSessionCache(join(root, "nope"), new Set()), 0);
      assert.equal(pruneClaudeSessionCache(root, new Set([file])), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：运行态绝不进缓存（AC④）", () => {
  it("同一文件、不同 statusOf → 不同 status，且零读盘", async () => {
    const root = await makeRoot("claude-cache-status-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      resetClaudeSessionCaches();

      const running = await scanClaudeSessions(root, new Map(), { statusOf: () => "running" });
      assert.equal(running[0].status, "running");
      const idle = await scanClaudeSessions(root, new Map(), { statusOf: () => "idle" });
      assert.equal(idle[0].status, "idle");
      // 按 updatedMs 分支的 statusOf 也必须每次现算
      const mixed = await scanClaudeSessions(root, new Map(), {
        statusOf: (_id, updatedMs) => (updatedMs > Date.parse("2020-01-01T00:00:00.000Z") ? "error" : "idle"),
      });
      assert.equal(mixed[0].status, "error");
      const noStatusOf = await scanClaudeSessions(root);
      assert.equal(noStatusOf[0].status, "idle", "缺省 statusOf → idle");

      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 1, "status 变化不触发重读");
      assert.equal(stats.fileParses, 1, "status 变化不触发重 parse");
      assert.equal(stats.cacheHits, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("快照里根本没有 status 字段，返回项是浅拷贝（调用方改不坏缓存）", async () => {
    const root = await makeRoot("claude-cache-copy-");
    try {
      const file = await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD, name: "原名" }));
      resetClaudeSessionCaches();
      const snap = await loadClaudeSessionSnapshot(root, file);
      assert.ok(snap.summary);
      assert.equal("status" in snap.summary, false, "缓存的静态摘要不含 status");
      assert.equal(snap.summary.cwd, CWD);
      assert.ok(snap.size > 0 && snap.mtimeMs > 0);

      const first = await scanClaudeSessions(root);
      first[0].name = "被调用方改坏";
      first[0].messageCount = -1;
      first[0].cwd = "/hacked";
      const second = await scanClaudeSessions(root);
      assert.equal(second[0].name, "原名", "调用方改返回项不污染缓存");
      assert.equal(second[0].messageCount, 2);
      assert.equal(second[0].cwd, CWD);
      assert.notEqual(second[0], first[0], "每次返回独立对象");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("history.jsonl 的 cwd 兜底同样现算：不同 historyIndex → 不同 cwd", async () => {
    const root = await makeRoot("claude-cache-history-");
    try {
      await writeSession(root, SID_NO_CWD, transcript(SID_NO_CWD, { text: "无 cwd 会话" }));
      resetClaudeSessionCaches();

      const noHistory = await scanClaudeSessions(root, new Map());
      assert.equal(noHistory[0].cwd, "", "无 history 映射时 cwd 为空");

      const history = parseClaudeHistoryIndex(
        JSON.stringify({ display: "x", timestamp: 1, project: "/Users/me/from-history", sessionId: SID_NO_CWD }),
      );
      const withHistory = await scanClaudeSessions(root, history);
      assert.equal(withHistory[0].cwd, "/Users/me/from-history", "history 兜底生效");
      // historyIndex 后到（首扫时还没加载）也不能被缓存钉死
      const againNoHistory = await scanClaudeSessions(root, new Map());
      assert.equal(againNoHistory[0].cwd, "");

      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 1, "historyIndex 变化不触发重读");
      assert.equal(stats.cacheHits, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：按 projectsDir 分键（AC⑤，pi 侧缺陷回归线）", () => {
  it("两个目录交替扫描互不清空：只在首轮各读一次", async () => {
    const rootA = await makeRoot("claude-cache-dirA-");
    const rootB = await makeRoot("claude-cache-dirB-");
    try {
      await writeSession(rootA, SID_A, transcript(SID_A, { cwd: "/Users/me/a" }));
      await writeSession(rootA, SID_B, transcript(SID_B, { cwd: "/Users/me/a" }));
      await writeSession(rootB, SID_C, transcript(SID_C, { cwd: "/Users/me/b" }));
      await writeSession(rootB, SID_NO_CWD, transcript(SID_NO_CWD, { cwd: "/Users/me/b" }));
      await writeSession(
        rootB,
        "eeeeeeee-0000-4000-8000-000000000005",
        transcript("eeeeeeee-0000-4000-8000-000000000005", { cwd: "/Users/me/b" }),
      );

      resetClaudeSessionCaches();
      // A/B 交替 3 轮：若共用全局 Map + 全局 prune，每轮都会把对方条目清空 → 15 次读盘
      for (let round = 0; round < 3; round += 1) {
        const a = await scanClaudeSessions(rootA);
        const b = await scanClaudeSessions(rootB);
        assert.equal(a.length, 2, `第 ${round + 1} 轮 A 目录会话数`);
        assert.equal(b.length, 3, `第 ${round + 1} 轮 B 目录会话数`);
        assert.equal(a.every((s) => s.cwd === "/Users/me/a"), true);
        assert.equal(b.every((s) => s.cwd === "/Users/me/b"), true);
      }
      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 5, "只在首轮读盘（A 2 + B 3）");
      assert.equal(stats.fileParses, 5);
      assert.equal(stats.cacheHits, 10, "后两轮 5 个文件全部命中");
      assert.equal(stats.pruned, 0, "交替扫描不该误清对方条目");
      assert.equal(stats.evictions, 0);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it("路径写法不同（尾斜杠 / 相对段）仍命中同一目录缓存", async () => {
    const root = await makeRoot("claude-cache-key-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 1);
      await scanClaudeSessions(`${root}/`);
      await scanClaudeSessions(join(root, ".", ""));
      assert.equal(claudeCacheStats().fileReads, 1, "同一目录的不同写法共用缓存键");
      assert.equal(claudeCacheStats().cacheHits, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：LRU 上限（AC3 淘汰）", () => {
  it("条目数超限 → 淘汰最久未用，结果仍完整正确", async () => {
    const root = await makeRoot("claude-cache-lru-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD, text: "A" }));
      await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD, text: "B" }));
      await writeSession(root, SID_C, transcript(SID_C, { cwd: CWD, text: "C" }));

      resetClaudeSessionCaches();
      setClaudeCacheLimits({ maxEntriesPerDir: 2 });
      assert.equal(claudeCacheLimits().maxEntriesPerDir, 2);
      await scanClaudeSessions(root);
      const cold = claudeCacheStats();
      assert.equal(cold.fileReads, 3, "冷扫仍读全部文件");
      assert.ok(cold.evictions >= 1, "超上限即淘汰");

      const second = await scanClaudeSessions(root);
      assert.equal(second.length, 3, "淘汰只影响性能，清单不缺项");
      assert.deepEqual(
        second.map((s) => s.lastUserMessage).sort(),
        ["A", "B", "C"],
      );
      assert.ok(claudeCacheStats().fileReads > cold.fileReads, "被淘汰的条目下轮需重读");

      // 放宽上限后恢复全命中
      resetClaudeSessionCaches();
      assert.equal(claudeCacheLimits().maxEntriesPerDir, 512, "reset 复位上限（测试间不残留）");
      await scanClaudeSessions(root);
      await scanClaudeSessions(root);
      const relaxed = claudeCacheStats();
      assert.equal(relaxed.fileReads, 3);
      assert.equal(relaxed.cacheHits, 3);
      assert.equal(relaxed.evictions, 0);
    } finally {
      resetClaudeSessionCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("源字节上限超限 → 不缓存该条目，扫描仍正确", async () => {
    const root = await makeRoot("claude-cache-bytes-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      await writeSession(root, SID_B, transcript(SID_B, { cwd: CWD }));

      resetClaudeSessionCaches();
      setClaudeCacheLimits({ maxBytesPerDir: 1 }); // 任何文件都超上限 → 写入即淘汰
      const first = await scanClaudeSessions(root);
      assert.equal(first.length, 2);
      const second = await scanClaudeSessions(root);
      assert.equal(second.length, 2);
      const stats = claudeCacheStats();
      assert.equal(stats.fileReads, 4, "字节上限下每轮都重读（上限即取舍）");
      assert.equal(stats.cacheHits, 0);
      assert.ok(stats.evictions >= 2);
      assert.deepEqual(second, first, "结果稳定");
    } finally {
      resetClaudeSessionCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("目录数超限 → 整目录淘汰，不影响正确性", async () => {
    const roots: string[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const root = await makeRoot(`claude-cache-dirs-${i}-`);
        roots.push(root);
        await writeSession(root, SID_A, transcript(SID_A, { cwd: `/Users/me/d${i}` }));
      }
      resetClaudeSessionCaches();
      setClaudeCacheLimits({ maxDirs: 2 });
      for (const root of roots) await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 3);
      assert.ok(claudeCacheStats().evictions >= 1, "目录数超限即淘汰最久未用目录");
      // 回到最早的目录：条目已被整目录淘汰 → 重读，但结果不变
      const again = await scanClaudeSessions(roots[0]);
      assert.equal(again.length, 1);
      assert.equal(again[0].cwd, "/Users/me/d0");
      assert.equal(claudeCacheStats().fileReads, 4);
    } finally {
      resetClaudeSessionCaches();
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude 清单快照缓存：容错语义（并发分批后不变）", () => {
  it("坏行 / 空文件 / 非会话文件混杂：不影响其它会话，负面结果也走缓存", async () => {
    const root = await makeRoot("claude-cache-broken-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD, text: "正常会话" }));
      await writeSession(root, SID_B, "{{{\n###\nnot json\n"); // 全坏行
      const fileC = await writeSession(root, SID_C, "");
      const dir = join(root, PROJECT);
      await writeFile(join(dir, "skill-injections.jsonl"), "{}\n", "utf8"); // 非 UUID 名：不进清单
      await mkdir(join(dir, "memory"), { recursive: true });
      await writeFile(join(dir, "memory", `${SID_A}.jsonl`), transcript(SID_A), "utf8"); // 子目录不扫

      resetClaudeSessionCaches();
      const first = await scanClaudeSessions(root, new Map(), { statusOf: () => "idle" });
      assert.equal(first.length, 3, "坏行/空文件也算会话条目（sessionId 用文件名兜底）");
      const a = first.find((s) => s.id === SID_A);
      assert.ok(a);
      assert.equal(a.lastUserMessage, "正常会话");
      assert.equal(a.messageCount, 2);
      assert.equal(first.find((s) => s.id === SID_B)?.messageCount, 0);
      assert.equal(claudeCacheStats().fileReads, 3);

      // 第二遍零读盘；坏文件修复后立即可见
      await scanClaudeSessions(root);
      assert.equal(claudeCacheStats().fileReads, 3, "坏文件同样命中缓存，不反复重读");
      await writeFile(fileC, transcript(SID_C, { cwd: CWD, text: "修好了" }), "utf8");
      const fixed = await scanClaudeSessions(root);
      assert.equal(fixed.find((s) => s.id === SID_C)?.lastUserMessage, "修好了");
      assert.equal(claudeCacheStats().fileReads, 4, "只重读被修的那个文件");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("目录不存在 → 空数组，且不清空别的目录缓存", async () => {
    const root = await makeRoot("claude-cache-missing-");
    try {
      await writeSession(root, SID_A, transcript(SID_A, { cwd: CWD }));
      resetClaudeSessionCaches();
      await scanClaudeSessions(root);
      const missing = await scanClaudeSessions(join(tmpdir(), "definitely-not-exists-claude-cache"));
      assert.deepEqual(missing, []);
      const after = await scanClaudeSessions(root);
      assert.equal(after.length, 1);
      assert.equal(claudeCacheStats().fileReads, 1, "扫空目录不影响已有缓存");
      assert.equal(claudeCacheStats().cacheHits, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("多文件（>并发度）结果完整且与串行口径一致：updatedAt 倒序", async () => {
    const root = await makeRoot("claude-cache-many-");
    try {
      const ids = [SID_A, SID_B, SID_C, SID_NO_CWD, "eeeeeeee-0000-4000-8000-000000000005"];
      for (let i = 0; i < ids.length; i += 1) {
        await writeSession(
          root,
          ids[i],
          transcript(ids[i], {
            cwd: CWD,
            at: `2026-09-29T09:0${i}:00.000Z`,
            atAssistant: `2026-09-29T09:1${i}:00.000Z`,
            text: `会话${i}`,
          }),
        );
      }
      resetClaudeSessionCaches();
      const first = await scanClaudeSessions(root);
      assert.equal(first.length, ids.length);
      for (let i = 1; i < first.length; i += 1) {
        assert.ok(Date.parse(first[i - 1].updatedAt) >= Date.parse(first[i].updatedAt), "updatedAt 倒序");
      }
      const second = await scanClaudeSessions(root);
      assert.deepEqual(second, first, "并发分批不引入顺序抖动");
      assert.equal(claudeCacheStats().fileReads, ids.length);
      assert.equal(claudeCacheStats().cacheHits, ids.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
