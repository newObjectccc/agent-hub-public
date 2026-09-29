/**
 * git 只读 API 单测：
 * 1. 路径穿越校验（resolveInsideRepo / commit ref 白名单）
 * 2. git 输出解析（status porcelain / ahead-behind / log / branches，mock execFile runner）
 * 3. createGitApi 参数组装（execFile 数组传参、`--` 终止选项）与截断/二进制防护
 * 4. 路由信封（非仓库 404、越界 400、正常 JSON）
 * 5. 只读硬保证：git.ts 源码不含任何 git 写子命令
 */
import { strict as assert } from "node:assert";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { ErrorCodes } from "../errors.js";
import {
  assertCommitRef,
  clampOutput,
  createGitApi,
  formatRelativeTime,
  MAX_FILE_BYTES,
  parseAheadBehind,
  parseBranches,
  parseLog,
  parsePorcelainStatus,
  resolveInsideRepo,
  type GitRunner,
} from "../git.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SessionListItem, SystemInfo } from "../types.js";

const sessionFixture: SessionListItem = {
  id: "sess-1",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo.jsonl",
};

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
};

const fakeHub: SessionHubLike = {
  getStatus: () => "idle",
  listSessions: async () => [sessionFixture],
  findSession: async () => sessionFixture,
  loadMessages: async (): Promise<MessageDto[]> => [],
  createSession: async () => sessionFixture,
  prompt: async () => ({ accepted: true, mode: "prompt" }),
  abort: async () => undefined,
  compact: async () => undefined,
  search: async () => [],
  loadTree: async () => null,
};

/* ============ 1. 路径穿越校验 ============ */

describe("git: 路径穿越校验 resolveInsideRepo", () => {
  const root = "/Users/me/Workspace/demo";

  it("仓库内相对路径正常解析", () => {
    assert.equal(resolveInsideRepo(root, "src/foo.ts"), resolve(root, "src/foo.ts"));
    assert.equal(resolveInsideRepo(root, "./a/b.txt"), resolve(root, "a/b.txt"));
  });

  it("../ 越界即抛 INVALID_PATH", () => {
    for (const bad of ["../evil", "a/../../evil", "../../../../etc/passwd", ".."]) {
      assert.throws(
        () => resolveInsideRepo(root, bad),
        (err: unknown) => (err as { code: string }).code === ErrorCodes.INVALID_PATH,
        bad,
      );
    }
  });

  it("绝对路径越界即抛 INVALID_PATH，绝对路径在仓库内允许", () => {
    assert.throws(() => resolveInsideRepo(root, "/etc/passwd"), /越出仓库根/);
    assert.equal(resolveInsideRepo(root, "/Users/me/Workspace/demo/x.ts"), resolve(root, "x.ts"));
  });

  it("空路径抛 INVALID_PATH；`..foo` 这类合法文件名不误伤", () => {
    assert.throws(() => resolveInsideRepo(root, "  "), /缺少文件路径/);
    assert.equal(resolveInsideRepo(root, "src/..foo"), resolve(root, "src/..foo"));
  });
});

describe("git: commit/ref 白名单 assertCommitRef", () => {
  it("接受 hash / HEAD / 分支名", () => {
    for (const ok of ["abc1234", "HEAD", "feature/x", "v1.2.3", "main~1", "HEAD@{0}"]) {
      assert.doesNotThrow(() => assertCommitRef(ok), ok);
    }
  });

  it("拒绝前导 `-`（选项注入）、`..` 范围、shell 元字符、空串", () => {
    for (const bad of ["-p", "--output=/tmp/x", "a..b", "a;b", "a && rm -rf /", "a b", "", "$(whoami)", "`id`"]) {
      assert.throws(() => assertCommitRef(bad), /非法 commit/, JSON.stringify(bad));
    }
  });
});

/* ============ 2. git 输出解析 ============ */

describe("git: 输出解析", () => {
  it("parsePorcelainStatus：状态字母 + 路径 + rename 新路径", () => {
    const out = [
      " M server/src/git.ts",
      "M  staged.ts",
      "MM both.ts",
      "?? untracked.txt",
      "R  old.ts -> new.ts",
      " D gone.ts",
    ].join("\n");
    const files = parsePorcelainStatus(out);
    assert.deepEqual(files, [
      { path: "server/src/git.ts", status: "M", origPath: null },
      { path: "staged.ts", status: "M", origPath: null },
      { path: "both.ts", status: "MM", origPath: null },
      { path: "untracked.txt", status: "??", origPath: null },
      { path: "new.ts", status: "R", origPath: "old.ts" },
      { path: "gone.ts", status: "D", origPath: null },
    ]);
  });

  it("parsePorcelainStatus：空输入 / 引号路径", () => {
    assert.deepEqual(parsePorcelainStatus(""), []);
    assert.deepEqual(parsePorcelainStatus('?? "a b.ts"'), [
      { path: "a b.ts", status: "??", origPath: null },
    ]);
  });

  it("parseAheadBehind：左=behind 右=ahead，异常输入归零", () => {
    assert.deepEqual(parseAheadBehind("2\t0"), { ahead: 0, behind: 2 });
    assert.deepEqual(parseAheadBehind("0\t7"), { ahead: 7, behind: 0 });
    assert.deepEqual(parseAheadBehind("garbage"), { ahead: 0, behind: 0 });
    assert.deepEqual(parseAheadBehind(""), { ahead: 0, behind: 0 });
  });

  it("parseLog：短 hash / author / 相对时间 / subject", () => {
    const now = Date.parse("2026-02-18T12:00:00.000Z");
    const text = [
      `abc1234\u001fpeter\u001f2026-02-18T11:30:00+08:00\u001ffeat: git 集成`,
      `deadbee\u001falice\u001f2026-02-10T09:00:00-06:00\u001ffix: \u001f含分隔符的 subject`,
    ].join("\n");
    const commits = parseLog(text, now);
    assert.equal(commits.length, 2);
    assert.deepEqual(Object.keys(commits[0]).sort(), ["author", "authorDate", "hash", "relativeTime", "subject"]);
    assert.equal(commits[0].hash, "abc1234");
    assert.equal(commits[0].author, "peter");
    assert.equal(commits[0].subject, "feat: git 集成");
    assert.equal(typeof commits[0].relativeTime, "string");
    assert.ok(commits[0].relativeTime.length > 0);
    assert.equal(commits[1].subject, "fix: \u001f含分隔符的 subject");
    assert.deepEqual(parseLog(""), []);
  });

  it("formatRelativeTime：刚刚/N分钟前/N小时前/N天前/具体日期", () => {
    const now = Date.parse("2026-02-18T12:00:00.000Z");
    assert.equal(formatRelativeTime(now - 5_000, now), "刚刚");
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5分钟前");
    assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3小时前");
    assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), "2天前");
    assert.match(formatRelativeTime(now - 30 * 86_400_000, now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("parseBranches：当前分支 + upstream", () => {
    const text = ["*\u001fmain\u001forigin/main", " \u001ffeat/w3-git\u001f", " \u001fdev\u001forigin/dev"].join("\n");
    const branches = parseBranches(text);
    assert.deepEqual(branches, [
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feat/w3-git", current: false, upstream: null },
      { name: "dev", current: false, upstream: "origin/dev" },
    ]);
  });

  it("clampOutput：超限截到最后一个换行并标记 truncated", () => {
    const small = clampOutput("a\nb\n", 1024);
    assert.deepEqual(small, { text: "a\nb\n", truncated: false });
    const big = clampOutput("aaa\nbbb\nccc\n", 6);
    assert.equal(big.truncated, true);
    assert.equal(big.text, "aaa");
  });
});

/* ============ 3. createGitApi（mock execFile runner） ============ */

describe("git: createGitApi（mock runner）", () => {
  let repoDir: string;

  before(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "agent-hub-git-"));
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(repoDir, "big.bin"), Buffer.alloc(16, 0));
  });

  after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  /** 按 args[0] 分发的 fake runner，并记录调用 */
  function makeRunner(handlers: Record<string, (args: string[]) => string>): { run: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      calls.push(args);
      const key = args[0] ?? "";
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected git command: ${key}`);
      return handler(args);
    };
    return { run, calls };
  }

  const statusHandlers: Record<string, (args: string[]) => string> = {
    "rev-parse": (args) => {
      if (args.includes("--show-toplevel")) return `${repoDir}\n`;
      if (args.some((a) => a.includes("@{upstream}"))) return "origin/main\n";
      return "main\n";
    },
    status: () => " M src/a.ts\n?? new.txt\n",
  };

  it("status：聚合分支/upstream/ahead-behind/dirty，execFile 数组传参", async () => {
    const { run, calls } = makeRunner({
      ...statusHandlers,
      "rev-list": () => "2\t0\n",
    });
    const api = createGitApi(run);
    const st = await api.status(repoDir);
    assert.equal(st.root, repoDir);
    assert.equal(st.branch, "main");
    assert.equal(st.detached, false);
    assert.equal(st.upstream, "origin/main");
    assert.equal(st.ahead, 0);
    assert.equal(st.behind, 2);
    assert.equal(st.dirtyCount, 2);
    assert.deepEqual(st.dirty[0], { path: "src/a.ts", status: "M", origPath: null });
    // 所有调用都是数组参数，无 shell 拼接
    for (const args of calls) assert.ok(Array.isArray(args));
  });

  it("status：无 upstream 时 ahead/behind 为 0 且不报错", async () => {
    const { run } = makeRunner({
      ...statusHandlers,
      "rev-parse": (args) => {
        if (args.includes("--show-toplevel")) return `${repoDir}\n`;
        if (args.some((a) => a.includes("@{upstream}"))) throw new Error("no upstream");
        return "main\n";
      },
    });
    const st = await createGitApi(run).status(repoDir);
    assert.equal(st.upstream, null);
    assert.equal(st.ahead, 0);
    assert.equal(st.behind, 0);
  });

  it("status：detached HEAD 时 branch 回退短 hash 并标记 detached", async () => {
    const { run } = makeRunner({
      ...statusHandlers,
      "rev-parse": (args) => {
        if (args.includes("--show-toplevel")) return `${repoDir}\n`;
        if (args.includes("--short")) return "abc1234\n";
        return "HEAD\n";
      },
    });
    const st = await createGitApi(run).status(repoDir);
    assert.equal(st.detached, true);
    assert.equal(st.branch, "abc1234");
  });

  it("status/log/diff/branches：cwd 缺 .git 或相对路径 → 404 NOT_REPO", async () => {
    const { run } = makeRunner(statusHandlers);
    const api = createGitApi(run);
    for (const bad of ["relative/path", "", join(tmpdir(), "definitely-not-a-repo-" + Date.now())]) {
      await assert.rejects(api.status(bad), (err: unknown) => (err as { code: string }).code === ErrorCodes.NOT_REPO);
    }
  });

  it("log：limit 钳制到 1..100 并走 --pretty 数组参数", async () => {
    const { run, calls } = makeRunner({
      ...statusHandlers,
      log: (args) => {
        assert.ok(args.includes("-n5"), JSON.stringify(args));
        return `abc1234\u001fpeter\u001f2026-02-18T11:00:00Z\u001ffeat: x\n`;
      },
    });
    const commits = await createGitApi(run).log(repoDir, 5);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].hash, "abc1234");
    assert.ok(calls.some((args) => args[0] === "log"));

    // 超限钳制：9999 → 100
    const { run: run2, calls: calls2 } = makeRunner({ ...statusHandlers, log: () => "" });
    await createGitApi(run2).log(repoDir, 9999);
    const logCall = calls2.find((args) => args[0] === "log");
    assert.ok(logCall?.includes("-n100"));
  });

  it("diff：无 file 走全量、有 file 校验穿越并以 `--` 传路径、commit 走 show；未跟踪文件用 --no-index 补全", async () => {
    const { run, calls } = makeRunner({
      ...statusHandlers,
      diff: (args) =>
        args.includes("--no-index")
          ? "diff --git a/untracked.ts b/untracked.ts\nnew file mode 100644\n--- /dev/null\n+++ b/untracked.ts\n@@ -0,0 +1 @@\n+new\n"
          : "diff --git a/src/a.ts b/src/a.ts\n",
      "ls-files": () => "untracked.ts\n",
      show: () => "diff --git a/src/a.ts b/src/a.ts\n",
    });
    const api = createGitApi(run);

    const all = await api.diff(repoDir, null, null);
    assert.equal(all.file, null);
    assert.equal(all.truncated, false);
    assert.match(all.diff, /diff --git a\/src\/a\.ts/);
    // 未跟踪新文件也出现在全量 diff 里
    assert.match(all.diff, /diff --git a\/untracked\.ts/);

    const one = await api.diff(repoDir, "src/a.ts", null);
    assert.equal(one.file, "src/a.ts");
    const diffCalls = calls.filter((args) => args[0] === "diff" && !args.includes("--no-index"));
    assert.deepEqual(diffCalls[0], ["diff", "--no-color", "HEAD", "--"]);
    assert.deepEqual(diffCalls[1], ["diff", "--no-color", "HEAD", "--", "src/a.ts"]);
    // 未跟踪补全调用带 --no-index 且路径经 `--` 传参
    const noIndex = calls.filter((args) => args.includes("--no-index"));
    assert.ok(noIndex.length > 0);
    assert.ok(noIndex[0].includes("--"));

    const at = await api.diff(repoDir, null, "abc1234");
    assert.equal(at.commit, "abc1234");
    const showCall = calls.filter((args) => args[0] === "show").pop();
    assert.ok(showCall?.includes("abc1234"));
    assert.ok(showCall?.includes("--"));

    // 路径穿越被拒，且不触发任何 git 调用
    await assert.rejects(api.diff(repoDir, "../outside.ts", null), /越出仓库根/);
    // 非法 commit 被拒
    await assert.rejects(api.diff(repoDir, null, "--output=/tmp/x"), /非法 commit/);
  });

  it("branches：解析分支列表 + current", async () => {
    const { run } = makeRunner({
      ...statusHandlers,
      branch: () => "*\u001fmain\u001forigin/main\n \u001ffeat/w3-git\u001f\n",
    });
    const out = await createGitApi(run).branches(repoDir);
    assert.equal(out.current, "main");
    assert.deepEqual(out.branches, [
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feat/w3-git", current: false, upstream: null },
    ]);
  });

  it("fileContent：正常读取 / 超 256KB 截断 / 二进制 400 / 不存在 404 / 穿越 400", async () => {
    const { run } = makeRunner(statusHandlers);
    const api = createGitApi(run);

    const ok = await api.fileContent(repoDir, "src/a.ts");
    assert.equal(ok.path, "src/a.ts");
    assert.equal(ok.truncated, false);
    assert.equal(ok.content, "export const a = 1;\n");
    assert.equal(typeof ok.size, "number");

    // 二进制
    await assert.rejects(api.fileContent(repoDir, "big.bin"), (err: unknown) => {
      const e = err as { code: string };
      return e.code === ErrorCodes.INVALID_FILE;
    });

    // 不存在
    await assert.rejects(api.fileContent(repoDir, "nope.ts"), (err: unknown) => {
      const e = err as { code: string };
      return e.code === ErrorCodes.FILE_NOT_FOUND;
    });

    // 穿越
    await assert.rejects(api.fileContent(repoDir, "../../../etc/passwd"), /越出仓库根/);

    // 截断上限：写一个 >256KB 的文本文件
    const bigPath = join(repoDir, "big.txt");
    await writeFile(bigPath, "x".repeat(MAX_FILE_BYTES + 100));
    const big = await api.fileContent(repoDir, "big.txt");
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.content, "utf8") <= MAX_FILE_BYTES);
  });
});

/* ============ 4. 路由信封 ============ */

describe("git: 路由（契约 §6 信封）", () => {
  let repoDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  const run: GitRunner = async (_cwd, args) => {
    switch (args[0]) {
      case "rev-parse":
        return args.includes("--show-toplevel") ? `${repoDir}\n` : "main\n";
      case "status":
        return " M src/a.ts\n";
      case "rev-list":
        return "1\t3\n";
      case "log":
        return `abc1234\u001fpeter\u001f2026-02-18T11:00:00Z\u001ffeat: x\n`;
      case "branch":
        return "*\u001fmain\u001f\n";
      case "diff":
      case "show":
        return "diff --git a/src/a.ts b/src/a.ts\n";
      case "ls-files":
        return "";
      default:
        throw new Error(`unexpected: ${args[0]}`);
    }
  };

  before(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "agent-hub-route-"));
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const a = 1;\n");
    app = await createApp({
      hub: fakeHub,
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      git: createGitApi(run),
    });
  });

  after(async () => {
    await app.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  const enc = encodeURIComponent;

  it("GET /api/git/status 正常信封", async () => {
    const res = await app.inject({ method: "GET", url: `/api/git/status?cwd=${enc(repoDir)}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "ahead",
      "behind",
      "branch",
      "cwd",
      "detached",
      "dirty",
      "dirtyCount",
      "root",
      "upstream",
    ]);
    assert.equal(body.branch, "main");
    assert.equal(body.ahead, 3);
    assert.equal(body.behind, 1);
  });

  it("GET /api/git/log?limit=5 → {commits:[...]}", async () => {
    const res = await app.inject({ method: "GET", url: `/api/git/log?cwd=${enc(repoDir)}&limit=5` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { commits: Array<Record<string, unknown>> };
    assert.equal(body.commits.length, 1);
    assert.deepEqual(Object.keys(body.commits[0]).sort(), ["author", "authorDate", "hash", "relativeTime", "subject"]);
  });

  it("GET /api/git/diff（全量 / 单文件 / 指定 commit）", async () => {
    for (const url of [
      `/api/git/diff?cwd=${enc(repoDir)}`,
      `/api/git/diff?cwd=${enc(repoDir)}&file=src/a.ts`,
      `/api/git/diff?cwd=${enc(repoDir)}&file=src/a.ts&commit=abc1234`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      const body = res.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["commit", "diff", "file", "root", "truncated"], url);
      assert.match(body.diff as string, /diff --git/, url);
    }
  });

  it("GET /api/git/branches → {branches,current}", async () => {
    const res = await app.inject({ method: "GET", url: `/api/git/branches?cwd=${enc(repoDir)}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { branches: Array<{ name: string; current: boolean }>; current: string };
    assert.equal(body.current, "main");
    assert.equal(body.branches[0].current, true);
  });

  it("GET /api/files/content 正常读取", async () => {
    const res = await app.inject({ method: "GET", url: `/api/files/content?cwd=${enc(repoDir)}&path=src/a.ts` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["content", "path", "root", "size", "truncated"]);
    assert.equal(body.content, "export const a = 1;\n");
    assert.equal(body.path, "src/a.ts");
  });

  it("非法 cwd / 非仓库 → 404 {error:{code:NOT_REPO}} 信封", async () => {
    for (const url of ["/api/git/status", "/api/git/status?cwd=relative", `/api/git/log?cwd=${enc("/tmp/no-such-repo")}`]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
      const body = res.json() as { error: { code: string; message: string } };
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.equal(body.error.code, ErrorCodes.NOT_REPO, url);
    }
  });

  it("路径穿越 → 400 {error:{code:INVALID_PATH}}，不泄漏仓库外内容", async () => {
    for (const url of [
      `/api/files/content?cwd=${enc(repoDir)}&path=../../../etc/passwd`,
      `/api/git/diff?cwd=${enc(repoDir)}&file=../outside.ts`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      const body = res.json() as { error: { code: string } };
      assert.equal(body.error.code, ErrorCodes.INVALID_PATH, url);
    }
  });

  it("非法 commit（选项注入） → 400 信封", async () => {
    const res = await app.inject({ method: "GET", url: `/api/git/diff?cwd=${enc(repoDir)}&commit=${enc("--output=x")}` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
  });
});

/* ============ 5. 只读硬保证 ============ */

describe("git: 只读硬保证（源码扫描）", () => {
  it("git.ts 不含任何 git 写子命令", async () => {
    const here = dirname(fileURLToPath(import.meta.url)); // server/dist/test
    const src = await readFile(resolve(here, "../../src/git.ts"), "utf8");
    const FORBIDDEN = [
      "commit ",
      "commit\"",
      "commit`",
      "checkout",
      "push",
      "merge",
      "rebase",
      "reset",
      "restore",
      "stash",
      "cherry-pick",
      "add ",
      "rm ",
      "mv ",
      "tag ",
      "fetch",
      "pull",
      "clean",
      "gc",
      "revert",
      "apply",
      "am ",
    ];
    // 只看传给 git 的命令字面量（数组参数里的子命令字符串），避免误伤注释/文档
    const argLiterals = [...src.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    for (const cmd of FORBIDDEN) {
      const bare = cmd.trim();
      assert.ok(
        !argLiterals.includes(bare),
        `git.ts 中出现疑似写子命令: ${bare}`,
      );
    }
    // diff/log/show/rev-parse/status/branch/rev-list/ls-files 是允许的只读集合
    const allowed = new Set([
      "diff",
      "log",
      "show",
      "rev-parse",
      "status",
      "branch",
      "rev-list",
      "ls-files",
    ]);
    const invoked = argLiterals.filter((s) => allowed.has(s));
    for (const cmd of invoked) assert.ok(allowed.has(cmd), `未知 git 子命令: ${cmd}`);
    // 兜底：git.ts 里实际出现的只读子命令必须都在白名单内
    const allGitSubcommands = new Set(argLiterals.filter((s) => /^(diff|log|show|rev-parse|status|branch|rev-list|ls-files|commit|checkout|push|merge|rebase|reset|restore|stash|fetch|pull|clean|revert|apply|tag|add|rm|mv|gc|cherry-pick|am)$/.test(s)));
    for (const cmd of allGitSubcommands) assert.ok(allowed.has(cmd), `非白名单 git 子命令: ${cmd}`);
  });
});
