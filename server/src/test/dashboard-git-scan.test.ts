/**
 * dashboard git 扫描性能专项（F2）单测：并发上限、每仓计数缓存（TTL/跨周/mtime 失效）、
 * 仓库清单缓存、单仓超时按 0 计。行为口径与 dashboard.test.ts 一致，只加不减。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  countWeekCommits,
  createWeekCommitsCache,
  REPO_COUNT_CACHE_TTL_MS,
  REPO_GIT_TIMEOUT_MS,
  REPO_LIST_CACHE_TTL_MS,
  resetGitBinCache,
  resolveGitBin,
  startOfWeek,
  type ExecFileFn,
} from "../dashboard.js";

const NOW = Date.parse("2026-02-18T12:00:00.000Z"); // 周三

interface FakeGitTracker {
  exec: ExecFileFn;
  calls: string[];
  maxInFlight: number;
  inFlight: number;
}

/** fake git：可选延迟（观测并发）、可选报错（超时/失败按 0） */
function fakeGit(options: { delayMs?: number; fail?: boolean } = {}): FakeGitTracker {
  const tracker: FakeGitTracker = {
    calls: [],
    maxInFlight: 0,
    inFlight: 0,
    exec: ((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      tracker.calls.push(args[1] ?? "");
      tracker.inFlight += 1;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
      const done = (): void => {
        tracker.inFlight -= 1;
        if (options.fail) cb(new Error("timed out"), "");
        else cb(null, "3\n");
      };
      if (options.delayMs) setTimeout(done, options.delayMs);
      else queueMicrotask(done);
    }) as unknown as ExecFileFn,
  };
  return tracker;
}

describe("dashboard git 扫描：并发与超时", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-gitperf-"));
    for (let i = 0; i < 12; i += 1) {
      await mkdir(join(root, `repo-${i}`, ".git"), { recursive: true });
    }
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("并发受限（默认 4）：12 仓库冷查询峰值并发 ≤ 4 且实际并行", async () => {
    const git = fakeGit({ delayMs: 20 });
    const total = await countWeekCommits(root, { now: NOW, execFileFn: git.exec });
    assert.equal(total, 12 * 3);
    assert.equal(git.calls.length, 12, "每仓一次 rev-list");
    assert.ok(git.maxInFlight <= 4, `并发峰值 ${git.maxInFlight} 应 ≤ 4`);
    assert.ok(git.maxInFlight >= 2, `并发峰值 ${git.maxInFlight} 应实际并行（>1）`);
  });

  it("concurrency=1 退化为串行", async () => {
    const git = fakeGit({ delayMs: 5 });
    await countWeekCommits(root, { now: NOW, execFileFn: git.exec, concurrency: 1, cache: createWeekCommitsCache() });
    assert.equal(git.maxInFlight, 1);
  });

  it("单仓 git 超时/失败按 0 计（不拖垮整体），超时默认 2s", async () => {
    assert.equal(REPO_GIT_TIMEOUT_MS, 2_000);
    const root2 = await mkdtemp(join(tmpdir(), "agent-hub-gitfail-"));
    try {
      await mkdir(join(root2, "ok", ".git"), { recursive: true });
      await mkdir(join(root2, "broken", ".git"), { recursive: true });
      const exec = ((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: string) => void) => {
        const timeout = (opts as { timeout?: number }).timeout;
        assert.ok(timeout !== undefined && timeout <= REPO_GIT_TIMEOUT_MS, `单仓超时应 ≤ ${REPO_GIT_TIMEOUT_MS}ms，实际 ${timeout}`);
        queueMicrotask(() => cb(args[1]!.endsWith("broken") ? new Error("timed out") : null, args[1]!.endsWith("broken") ? "" : "7\n"));
      }) as unknown as ExecFileFn;
      assert.equal(await countWeekCommits(root2, { now: NOW, execFileFn: exec }), 7);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});

describe("dashboard git 扫描：git 可执行解析（避开 PATH 查找开销）", () => {
  it("which 输出绝对路径 → 用之；垃圾/报错 → 回退 \"git\"；解析结果缓存一次", async () => {
    resetGitBinCache();
    let calls = 0;
    const absExec = ((_cmd: string, _args: string[], _o: unknown, cb: (err: Error | null, out: string) => void) => {
      calls += 1;
      cb(null, "/usr/bin/git\n");
    }) as unknown as ExecFileFn;
    assert.equal(await resolveGitBin(absExec), "/usr/bin/git");
    assert.equal(await resolveGitBin(absExec), "/usr/bin/git");
    assert.equal(calls, 1, "解析结果缓存（只 which 一次）");

    resetGitBinCache();
    const junkExec = ((_c: string, _a: string[], _o: unknown, cb: (err: Error | null, out: string) => void) =>
      cb(null, "3\n")) as unknown as ExecFileFn;
    assert.equal(await resolveGitBin(junkExec), "git", "非路径输出回退 git");

    resetGitBinCache();
    const brokenExec = ((_c: string, _a: string[], _o: unknown, cb: (err: Error | null, out: string) => void) =>
      cb(new Error("which not found"), "")) as unknown as ExecFileFn;
    assert.equal(await resolveGitBin(brokenExec), "git", "解析失败回退 git");
  });
});

describe("dashboard git 扫描：缓存语义", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-gitcache-"));
    await mkdir(join(root, "repo-a", ".git"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("每仓计数缓存：热查询 0 次 git 调用；TTL 内不重算，过期重算", async () => {
    const cache = createWeekCommitsCache();
    const git = fakeGit();
    assert.equal(await countWeekCommits(root, { now: NOW, execFileFn: git.exec, cache }), 3);
    assert.equal(git.calls.length, 1);

    // 热查询（TTL 内）：不再打 git
    assert.equal(await countWeekCommits(root, { now: NOW + 60_000, execFileFn: git.exec, cache }), 3);
    assert.equal(git.calls.length, 1, "热查询不触发 git 子进程");

    // TTL 过期（5min）后重算
    assert.equal(
      await countWeekCommits(root, { now: NOW + REPO_COUNT_CACHE_TTL_MS + 1_000, execFileFn: git.exec, cache }),
      3,
    );
    assert.equal(git.calls.length, 2, "TTL 过期重算");
  });

  it("跨周失效：周窗变了必须重算（不能沿用上周数字）", async () => {
    const cache = createWeekCommitsCache();
    const git = fakeGit();
    await countWeekCommits(root, { now: NOW, execFileFn: git.exec, cache });
    const nextWeek = startOfWeek(NOW) + 8 * 24 * 60 * 60 * 1000 + 3_600_000;
    await countWeekCommits(root, { now: nextWeek, execFileFn: git.exec, cache });
    assert.equal(git.calls.length, 2, "跨周立即重算（不受 5min TTL 保护）");
  });

  it("仓库 mtime 变化失效（可选增强）：touch .git 后重算", async () => {
    const cache = createWeekCommitsCache();
    const git = fakeGit();
    await countWeekCommits(root, { now: NOW, execFileFn: git.exec, cache });
    assert.equal(git.calls.length, 1);
    const future = new Date(NOW + 24 * 60 * 60 * 1000);
    await utimes(join(root, "repo-a", ".git"), future, future);
    await countWeekCommits(root, { now: NOW + 60_000, execFileFn: git.exec, cache });
    assert.equal(git.calls.length, 2, "仓库变更后重算");
  });

  it("仓库清单缓存 30min：期间新增仓库不重扫；过期后纳入", async () => {
    const cache = createWeekCommitsCache();
    const git = fakeGit();
    assert.equal(await countWeekCommits(root, { now: NOW, execFileFn: git.exec, cache }), 3);
    await mkdir(join(root, "repo-new", ".git"), { recursive: true });
    // 清单 TTL 内：仍按旧清单（1 仓），git 只在计数过期时才跑
    assert.equal(await countWeekCommits(root, { now: NOW + 60_000, execFileFn: git.exec, cache }), 3);
    assert.equal(git.calls.length, 1);
    // 清单 TTL 过期：新仓库纳入（计数缓存也过期 → 2 次 git）
    const afterListTtl = NOW + REPO_LIST_CACHE_TTL_MS + 1_000;
    assert.equal(await countWeekCommits(root, { now: afterListTtl, execFileFn: git.exec, cache }), 6);
    assert.equal(git.calls.length, 3);
  });
});
