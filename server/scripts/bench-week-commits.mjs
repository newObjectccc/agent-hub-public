#!/usr/bin/env node
/**
 * dashboard git 扫描性能基准（F2，⭐ 专项）。
 *
 * 对比「旧算法」（串行 walk + 顺序 rev-list、5s 超时、无缓存）与「新算法」
 * （并行 walk + 4 并发 rev-list、2s 超时、仓库清单 30min / 每仓计数 5min 缓存）。
 * 只读：仅跑 `git rev-list --count --since=… HEAD`，不改任何仓库状态。
 *
 * 用法：
 *   node server/scripts/bench-week-commits.mjs [workspaceRoot] [--runs N]
 *   （先 pnpm -C server build；workspaceRoot 缺省 ~/Workspace）
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distHref = new URL("../dist/dashboard.js", import.meta.url).href;
const { countWeekCommits, createWeekCommitsCache, findGitRepos, resolveGitBin, startOfWeek } = await import(distHref);

const args = process.argv.slice(2);
const runsArg = args.indexOf("--runs");
const RUNS = runsArg >= 0 ? Number.parseInt(args[runsArg + 1], 10) || 3 : 3;
const root = args.find((a) => !a.startsWith("--") && a !== String(RUNS)) ?? join(homedir(), "Workspace");

// ---------- 旧算法（优化前等价复刻：串行 + 无缓存 + 5s 超时） ----------

async function legacyFindGitRepos(rootDir, maxDepth = 2) {
  const repos = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      await stat(join(dir, ".git"));
      repos.push(dir);
      return;
    } catch {
      /* not a repo */
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1);
    }
  }
  await walk(rootDir, 0);
  return repos;
}

function legacyGitCount(repo, since) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repo, "rev-list", "--count", `--since=${since}`, "HEAD"],
      { timeout: 5_000, windowsHide: true },
      (error, out) => resolve(error === null ? Number.parseInt(String(out ?? "0"), 10) || 0 : 0),
    );
  });
}

async function legacyCountWeekCommits(rootDir, now) {
  const since = new Date(startOfWeek(now)).toISOString();
  const repos = await legacyFindGitRepos(rootDir);
  let total = 0;
  for (const repo of repos) total += await legacyGitCount(repo, since); // 串行（旧痛点）
  return total;
}

// ---------- 计时 ----------

async function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, value };
}

const fmt = (ms) => `${ms.toFixed(0)}ms`;

console.log(`[bench] workspaceRoot = ${root}（runs=${RUNS}）`);
const now = Date.now();
const repos = await findGitRepos(root, 2);
console.log(`[bench] 仓库数（depth≤2）= ${repos.length}`);

// A/B 交替执行（旧/新冷/新热一轮一换），抵消机器负载漂移；冷查询每轮全新缓存
const legacyRuns = [];
const newColdRuns = [];
const newColdPathRuns = [];
const newHotRuns = [];
const gitBin = await resolveGitBin(); // 生产路径：解析 git 绝对路径（避开 PATH 查找开销）
console.log(`[bench] gitBin = ${gitBin}`);
const hotCache = createWeekCommitsCache();
await countWeekCommits(root, { now, cache: hotCache, gitBin }); // 热查询共用一份预热缓存
let newTotal = 0;
let legacyTotal = 0;
let hotTotal = 0;
for (let i = 0; i < RUNS; i += 1) {
  const legacy = await time("legacy", () => legacyCountWeekCommits(root, now));
  legacyRuns.push(legacy.ms);
  legacyTotal = legacy.value;
  console.log(`[bench] 旧算法 冷#${i + 1}: ${fmt(legacy.ms)}（weekCommits=${legacy.value}）`);

  const cold = await time("new-cold", () => countWeekCommits(root, { now, cache: createWeekCommitsCache(), gitBin }));
  newColdRuns.push(cold.ms);
  newTotal = cold.value;
  console.log(`[bench] 新算法 冷#${i + 1}: ${fmt(cold.ms)}（weekCommits=${cold.value}）`);

  // 消融组：仅去掉绝对路径优化（量化 PATH 查找开销）
  const coldPath = await time("new-cold-path", () =>
    countWeekCommits(root, { now, cache: createWeekCommitsCache(), gitBin: "git" }),
  );
  newColdPathRuns.push(coldPath.ms);
  console.log(`[bench] 新算法 冷(PATH 查找)#${i + 1}: ${fmt(coldPath.ms)}`);

  const hot = await time("new-hot", () => countWeekCommits(root, { now, cache: hotCache, gitBin }));
  newHotRuns.push(hot.ms);
  hotTotal = hot.value;
  console.log(`[bench] 新算法 热#${i + 1}: ${fmt(hot.ms)}（weekCommits=${hot.value}）`);
}

const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const legacyMed = median(legacyRuns);
const newColdMed = median(newColdRuns);
const newHotMed = median(newHotRuns);

console.log("\n| 场景 | 中位耗时 | 目标 | 达成 |");
console.log("| --- | --- | --- | --- |");
console.log(`| 旧算法 冷查询（串行/无缓存/PATH 查找） | ${fmt(legacyMed)} | — | 基线 |`);
console.log(`| 新算法 冷查询（4 并发 + git 绝对路径） | ${fmt(newColdMed)} | <3s | ${newColdMed < 3000 ? "✅" : "❌"} |`);
console.log(`| 新算法 冷查询（消融：仅 PATH 查找） | ${fmt(median(newColdPathRuns))} | — | 参考 |`);
console.log(`| 新算法 热查询（缓存命中） | ${fmt(newHotMed)} | <100ms | ${newHotMed < 100 ? "✅" : "❌"} |`);
console.log(`| 冷查询提速 | ${(legacyMed / newColdMed).toFixed(2)}x | | |`);
console.log(`\n[bench] weekCommits：legacy=${legacyTotal} / new(cold)=${newTotal} / new(hot)=${hotTotal}`);
