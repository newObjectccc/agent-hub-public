/**
 * git 资源/性能加固回归（OOM 审计 P2-1 / P2-3）：
 * - P2-1：diff 未跟踪补全从串行（20 × 15s 最坏 5 分钟）改并发池（≤4）+
 *   单请求总超时钳制（Promise.race 20s，超时返回已得部分）——并发上界/顺序保持/超时钳制/数量上限
 * - P2-3：statusCache 过期即删 + LRU 上限——TTL 内命中不重算、过期重算、命中刷新位次、超限逐出最久未用
 * 独立成档（不改 git.test.ts），mock runner 不碰真实 git。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createGitApi,
  DIFF_CONCURRENCY,
  STATUS_CACHE_MAX,
  UNTRACKED_DIFF_LIMIT,
  type GitRunner,
} from "../git.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("git: diff 并发池 + 总超时钳制（P2-1）", () => {
  let repoDir: string;

  before(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "agent-hub-git-perf-"));
    await mkdir(join(repoDir, ".git"), { recursive: true });
  });

  after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  /** 基础命令 mock：rev-parse / diff HEAD / ls-files */
  function baseHandlers(untracked: string[]): Record<string, (args: string[]) => Promise<string> | string> {
    return {
      "rev-parse": (args: string[]) => (args.includes("--show-toplevel") ? `${repoDir}\n` : "main\n"),
      diff: async (args: string[]) => (args.includes("--no-index") ? "" : "diff --git a/src/a.ts b/src/a.ts\n"),
      "ls-files": () => untracked.map((u) => `${u}\n`).join(""),
    };
  }

  function makeRunner(
    handlers: Record<string, (args: string[]) => Promise<string> | string>,
  ): { run: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      calls.push(args);
      const handler = handlers[args[0] ?? ""];
      if (!handler) throw new Error(`unexpected git command: ${args[0] ?? ""}`);
      return handler(args);
    };
    return { run, calls };
  }

  it("未跟踪补 diff 并发不超过 DIFF_CONCURRENCY（4），且结果按文件序拼接", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    let inflight = 0;
    let maxInflight = 0;
    const handlers = baseHandlers(files);
    handlers.diff = async (args: string[]): Promise<string> => {
      if (!args.includes("--no-index")) return "diff --git a/src/a.ts b/src/a.ts\n";
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // 乱序完成（后面的文件更快），验证按索引写回不乱序
      const target = args[args.length - 1];
      const idx = Number(target.slice(1).split(".")[0]);
      await sleep(idx % 2 === 0 ? 30 : 1);
      inflight -= 1;
      return `diff --git a/${target} b/${target}\n+${target}\n`;
    };
    const api = createGitApi(makeRunner(handlers).run);
    const res = await api.diff(repoDir, null, null);
    assert.ok(maxInflight <= DIFF_CONCURRENCY, `并发 ${maxInflight} 超上限 ${DIFF_CONCURRENCY}`);
    assert.ok(maxInflight > 1, `应实际并发执行，实际峰值 ${maxInflight}`);
    // 顺序：u0..u9 按 ls-files 序出现
    const order = files.map((f) => res.diff.indexOf(`a/${f}`));
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] > order[i - 1], `第 ${i} 个文件乱序：${JSON.stringify(order)}`);
    }
  });

  it("单请求总超时钳制（Promise.race）：超时返回已得部分，挂起项不阻塞返回", async () => {
    const files = ["u0.ts", "u1.ts", "u2.ts", "u3.ts"];
    const handlers = baseHandlers(files);
    handlers.diff = async (args: string[]): Promise<string> => {
      if (!args.includes("--no-index")) return "diff --git a/src/a.ts b/src/a.ts\n";
      const target = args[args.length - 1];
      if (target === "u1.ts" || target === "u3.ts") return new Promise(() => undefined); // 挂死（15s exec 超时的最坏情形）
      await sleep(5);
      return `diff --git a/${target} b/${target}\n+${target}\n`;
    };
    const api = createGitApi(makeRunner(handlers).run, { diffTimeoutMs: 120, diffConcurrency: 4 });
    const startedAt = Date.now();
    const res = await api.diff(repoDir, null, null);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2_000, `超时钳制失效：耗时 ${elapsed}ms`);
    // 已得部分返回（u0/u2 在预算内完成），挂起项被丢弃
    assert.match(res.diff, /a\/u0\.ts/);
    assert.match(res.diff, /a\/u2\.ts/);
    assert.doesNotMatch(res.diff, /a\/u1\.ts/);
    assert.doesNotMatch(res.diff, /a\/u3\.ts/);
    // 主 diff 也在预算内拿到
    assert.match(res.diff, /a\/src\/a\.ts/);
  });

  it("总超时边界：预算耗尽后不再起新的 git 子进程（未开始项直接跳过）", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `u${i}.ts`);
    let noIndexStarted = 0;
    const handlers = baseHandlers(files);
    handlers.diff = async (args: string[]): Promise<string> => {
      if (!args.includes("--no-index")) return "diff --git a/src/a.ts b/src/a.ts\n";
      noIndexStarted += 1;
      return new Promise(() => undefined); // 全部挂死 → 只有已入队的 ≤并发数 个会启动
    };
    const api = createGitApi(makeRunner(handlers).run, { diffTimeoutMs: 80, diffConcurrency: 2 });
    const res = await api.diff(repoDir, null, null);
    assert.ok(noIndexStarted <= 2, `预算耗尽后仍起子进程：启动 ${noIndexStarted} 个`);
    assert.equal(res.diff, "diff --git a/src/a.ts b/src/a.ts\n", "一个都没拿到时返回已得主 diff");
  });

  it("未跟踪补全数量上限保持（UNTRACKED_DIFF_LIMIT=20）", async () => {
    const files = Array.from({ length: 25 }, (_, i) => `u${i}.ts`);
    let noIndexCalls = 0;
    const handlers = baseHandlers(files);
    handlers.diff = async (args: string[]): Promise<string> => {
      if (!args.includes("--no-index")) return "";
      noIndexCalls += 1;
      return "";
    };
    const api = createGitApi(makeRunner(handlers).run);
    await api.diff(repoDir, null, null);
    assert.equal(noIndexCalls, UNTRACKED_DIFF_LIMIT, `只对前 ${UNTRACKED_DIFF_LIMIT} 个未跟踪文件补 diff`);
  });

  it("commit 路径不受钳制影响（走 show 单调用）", async () => {
    const { run, calls } = makeRunner({
      "rev-parse": (args: string[]) => (args.includes("--show-toplevel") ? `${repoDir}\n` : "main\n"),
      show: () => "diff --git a/src/a.ts b/src/a.ts\n",
    });
    const api = createGitApi(run, { diffTimeoutMs: 5_000 });
    const res = await api.diff(repoDir, null, "abc1234");
    assert.equal(res.commit, "abc1234");
    assert.equal(calls.filter((args) => args[0] === "show").length, 1);
    assert.equal(calls.filter((args) => args[0] === "ls-files").length, 0);
  });
});

describe("git: statusCache 过期即删 + LRU 上限（P2-3）", () => {
  let baseDir: string;
  const repoDirs: string[] = [];

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "agent-hub-git-lru-"));
  });

  after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function makeRepo(name: string): Promise<string> {
    const dir = join(baseDir, name);
    await mkdir(join(dir, ".git"), { recursive: true });
    repoDirs.push(dir);
    return dir;
  }

  /** 只统计实际执行的 status --porcelain 调用（缓存命中 = 0 新增） */
  function countingRunner(): { run: GitRunner; statusRuns: () => number } {
    let statusRuns = 0;
    const run: GitRunner = async (_cwd, args) => {
      const key = args[0] ?? "";
      if (key === "rev-parse") return args.includes("--show-toplevel") ? `${_cwd}\n` : "main\n";
      if (key === "status") {
        statusRuns += 1;
        return " M a.ts\n";
      }
      return "";
    };
    return { run, statusRuns: () => statusRuns };
  }

  it("TTL 内命中不重算；过期重算并重新入缓存（过期即删语义）", async () => {
    const repo = await makeRepo("ttl");
    const { run, statusRuns } = countingRunner();
    const api = createGitApi(run);
    const realNow = Date.now;
    try {
      let now = realNow();
      Date.now = () => now;

      await api.status(repo);
      assert.equal(statusRuns(), 1);
      await api.status(repo);
      assert.equal(statusRuns(), 1, "TTL 内命中缓存不重算");

      now += 30_000 + 1_000; // 越过 30s TTL
      await api.status(repo);
      assert.equal(statusRuns(), 2, "过期后重算（旧条目已删，不再驻留）");
      await api.status(repo);
      assert.equal(statusRuns(), 2, "重算结果重新入缓存");
    } finally {
      Date.now = realNow;
    }
  });

  it("命中刷新 LRU 位次：被访问过的条目不被逐出，最久未用的先逐出", async () => {
    const { run, statusRuns } = countingRunner();
    const api = createGitApi(run);
    // 灌满缓存（cap 个不同 cwd）
    const repos: string[] = [];
    for (let i = 0; i < STATUS_CACHE_MAX; i += 1) repos.push(await makeRepo(`c${i}`));
    for (const dir of repos) await api.status(dir);
    assert.equal(statusRuns(), STATUS_CACHE_MAX);

    // 命中 repos[0]：刷新其 LRU 位次（成为最近使用）
    await api.status(repos[0]);
    assert.equal(statusRuns(), STATUS_CACHE_MAX, "命中不重算");

    // 再来 2 个新 cwd：逐出最久未用的 repos[1]、repos[2]；repos[0]（刚用过）与 repos[3+] 保留
    const extra1 = await makeRepo("x1");
    const extra2 = await makeRepo("x2");
    await api.status(extra1);
    await api.status(extra2);
    assert.equal(statusRuns(), STATUS_CACHE_MAX + 2);

    await api.status(repos[0]);
    assert.equal(statusRuns(), STATUS_CACHE_MAX + 2, "最近使用的 repos[0] 未被逐出（LRU 命中）");
    await api.status(repos[1]);
    assert.equal(statusRuns(), STATUS_CACHE_MAX + 3, "最久未用的 repos[1] 已被逐出（重算）");
    // repos[1] 重算入缓存的插入又挤出次久的 repos[3]（链式逐出语义：每次插入逐出当时最久未用）
    await api.status(repos[3]);
    assert.equal(statusRuns(), STATUS_CACHE_MAX + 4, "repos[3] 已被链式逐出（重算）");
    await api.status(repos[10]);
    assert.equal(statusRuns(), STATUS_CACHE_MAX + 4, "窗口内的 repos[10] 仍在缓存（不误逐）");
  });

  it("边界：失败结果同样受 TTL/LRU 治理（非仓库路径不永久驻留）", async () => {
    // rev-parse 返回空 root → resolveRepoRoot 抛 NOT_REPO（runner 层失败，可观测重算次数）
    let runs = 0;
    const run: GitRunner = async (_cwd, args) => {
      if (args[0] === "rev-parse") {
        runs += 1;
        return "\n";
      }
      return "";
    };
    const api = createGitApi(run);
    const bad = await makeRepo("bad-repo");
    const realNow = Date.now;
    try {
      let now = realNow();
      Date.now = () => now;
      await assert.rejects(api.status(bad));
      assert.equal(runs, 1);
      await assert.rejects(api.status(bad));
      assert.equal(runs, 1, "失败也短缓存（TTL 内命中缓存的错误）");
      now += 30_000 + 1_000;
      await assert.rejects(api.status(bad));
      assert.equal(runs, 2, "失败条目过期即删并重算");
    } finally {
      Date.now = realNow;
    }
  });
});
