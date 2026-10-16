/**
 * 快照缓存按根目录分键（防多源交替扫描互相清空）。
 *
 * 修复前的实测缺陷：`snapshotCache` 是模块级单一 Map，而 `pruneSessionFileCache(本次 files)`
 * 会删掉所有不在本次集合里的条目 —— 两个不同根目录交替扫描时，每轮都把对方缓存清空：
 *   只扫一个目录 ×4：1190ms → 6ms/6ms/6ms，cacheHits=723      ✅
 *   与另一目录交替 ×4：1154/1197/1150/1146ms，cacheHits=0     ❌ 每轮都是全量冷扫
 *   甚至与一个空目录交替也一样被打回冷扫（每轮 ~1145ms）
 * 当前生产恰好没爆（SearchService 与 SessionHub 共用同一个 sessionDir），但
 * lineageFileCaches 早已按 sessionDir 分键——同一份代码两种口径，接第二个源就会炸。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  resetSessionCaches,
  scanSessions,
  sessionCacheStats,
  loadSessionSnapshot,
  pruneSessionFileCache,
} from "../sessions/scan.js";

/** 写一个最小可解析的 pi 会话文件（header + 一条 user 消息） */
async function writeSession(rootDir: string, enc: string, id: string, cwd: string): Promise<string> {
  const dir = join(rootDir, enc);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-02-18T09:00:00.000Z", cwd }),
      JSON.stringify({
        type: "message",
        id: `${id}-u1`,
        parentId: null,
        timestamp: "2026-02-18T10:00:00.000Z",
        message: { role: "user", content: `消息 ${id}`, timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
      }),
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("快照缓存按根目录分键", () => {
  let dirA: string;
  let dirB: string;

  before(async () => {
    dirA = await mkdtemp(join(tmpdir(), "agent-hub-cache-a-"));
    dirB = await mkdtemp(join(tmpdir(), "agent-hub-cache-b-"));
    await writeSession(dirA, "--tmp-a--", "a1", "/tmp/a");
    await writeSession(dirA, "--tmp-a--", "a2", "/tmp/a");
    await writeSession(dirB, "--tmp-b--", "b1", "/tmp/b");
  });
  after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetSessionCaches();
  });

  it("核心回归线：两个根目录交替扫描，双方缓存都不被清空（修复前 cacheHits=0）", async () => {
    // 第一轮：两边都冷扫
    await scanSessions(dirA);
    await scanSessions(dirB);
    const afterCold = sessionCacheStats();
    assert.equal(afterCold.cacheHits, 0, "第一轮应全冷");
    assert.equal(afterCold.fileReads, 3, "3 个文件各读一次");

    // 第二、三轮交替：修复前这里每轮都重新全量读盘（对方的 prune 把本方缓存清空了）
    await scanSessions(dirA);
    await scanSessions(dirB);
    await scanSessions(dirA);
    await scanSessions(dirB);
    const after = sessionCacheStats();
    assert.equal(after.fileReads, 3, `交替扫描不得重复读盘，实际 reads=${after.fileReads}`);
    assert.equal(after.fileParses, 3, `交替扫描不得重复 parse，实际 parses=${after.fileParses}`);
    assert.equal(after.cacheHits, 6, `四轮交替应命中 6 次（2+2+2），实际 ${after.cacheHits}`);
  });

  it("与一个空目录/不存在的目录交替，也不打回冷扫（修复前每轮 ~1145ms）", async () => {
    await scanSessions(dirA);
    const cold = sessionCacheStats().fileReads;
    const emptyDir = join(dirB, "definitely-empty");
    for (let i = 0; i < 3; i += 1) {
      await scanSessions(dirA);
      await scanSessions(emptyDir); // 扫不到任何文件 → 修复前会把 A 的缓存全 prune 掉
    }
    assert.equal(sessionCacheStats().fileReads, cold, "空目录扫描不得清空另一个根目录的缓存");
    assert.ok(sessionCacheStats().cacheHits >= 6, "A 的后续扫描应全部命中缓存");
  });

  it("prune 只作用于指定根目录：A 里删文件不误删 B 的缓存", async () => {
    await scanSessions(dirA);
    await scanSessions(dirB);
    await rm(join(dirA, "--tmp-a--", "a2.jsonl"), { force: true });
    await scanSessions(dirA); // 触发 A 的 prune
    const readsBeforeB = sessionCacheStats().fileReads;
    await scanSessions(dirB);
    assert.equal(sessionCacheStats().fileReads, readsBeforeB, "B 的缓存不该被 A 的 prune 影响");
  });

  it("显式 API：带 rootDir 的 loadSessionSnapshot/pruneSessionFileCache 互不干扰", async () => {
    const fileA = join(dirA, "--tmp-a--", "a1.jsonl");
    const fileB = join(dirB, "--tmp-b--", "b1.jsonl");
    await loadSessionSnapshot(fileA, dirA);
    await loadSessionSnapshot(fileB, dirB);
    const reads = sessionCacheStats().fileReads;

    // prune A（只见到 A 的文件）：B 的条目必须还在
    pruneSessionFileCache(new Set([fileA]), dirA);
    await loadSessionSnapshot(fileB, dirB);
    assert.equal(sessionCacheStats().fileReads, reads, "B 的快照不该被 A 的 prune 清掉");

    // 再命中 A（未被 prune 的条目）
    await loadSessionSnapshot(fileA, dirA);
    assert.equal(sessionCacheStats().fileReads, reads, "A 保留的条目应继续命中");
  });

  it("不传 rootDir 走兼容桶：旧签名行为不变（同一桶内仍会互相 prune）", async () => {
    const fileA = join(dirA, "--tmp-a--", "a1.jsonl");
    const fileB = join(dirB, "--tmp-b--", "b1.jsonl");
    await loadSessionSnapshot(fileA);
    const reads = sessionCacheStats().fileReads;
    await loadSessionSnapshot(fileA);
    assert.equal(sessionCacheStats().fileReads, reads, "同桶内命中缓存");
    // 兼容桶的 prune 语义保持原样（只清这个桶）
    pruneSessionFileCache(new Set([fileB]));
    await loadSessionSnapshot(fileA);
    assert.ok(sessionCacheStats().fileReads > reads, "被 prune 后重新读盘（旧语义不回退）");
  });

  it("resetSessionCaches 清空所有根目录的缓存", async () => {
    await scanSessions(dirA);
    await scanSessions(dirB);
    resetSessionCaches();
    const before = sessionCacheStats().fileReads;
    await scanSessions(dirA);
    assert.ok(sessionCacheStats().fileReads > before, "reset 后应重新读盘");
  });
});
