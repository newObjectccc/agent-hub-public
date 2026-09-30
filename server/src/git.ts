/**
 * 只读 git 集成（docs/API_CONTRACT.md §6）。
 *
 * 硬约束：
 * - 只调用只读子命令（rev-parse/status/log/diff/show/branch/rev-list），绝不提供
 *   commit/checkout/push 等写操作；额外设置 GIT_OPTIONAL_LOCKS=0 避免 git 加锁。
 * - 所有 git 参数经 execFile 数组传参，禁止 shell 拼接（防注入）。
 * - cwd 必须是绝对路径且存在 .git（目录或 worktree 文件），否则 404 信封。
 * - file/path/commit 参数做白名单与路径穿越校验（resolve 后必须在仓库根内）。
 * - 输出统一截断上限（diff 512KB / 文件 256KB），防止超大响应拖垮手机端。
 */
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { ErrorCodes, HubError } from "./errors.js";
import type {
  FileContentResult,
  GitBranchInfo,
  GitCommit,
  GitDiffResult,
  GitDirtyFile,
  GitStatusResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** diff 输出上限（字节） */
export const MAX_DIFF_BYTES = 512 * 1024;
/** 文件预览上限（字节） */
export const MAX_FILE_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** 可注入的 git 运行器（测试 mock 用） */
export type GitRunner = (cwd: string, args: string[], opts?: GitRunOpts) => Promise<string>;

export interface GitRunOpts {
  /** 允许的退出码（如 git diff --no-index 有差异时退 1） */
  okExitCodes?: number[];
}

/** 真实 git 运行器：execFile 数组传参 + 只读环境变量 */
export const runGit: GitRunner = async (cwd, args, opts) => {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        // 只读硬保证：git 不取任何锁文件（status/diff 不写 index.lock）
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: number; stdout?: string };
    if (typeof e.code === "number" && (opts?.okExitCodes ?? []).includes(e.code)) {
      return e.stdout ?? "";
    }
    const detail = (e.stderr ?? e.message ?? String(err)).trim().slice(0, 400);
    throw new HubError(ErrorCodes.GIT_FAILED, `git ${args[0] ?? ""} 失败: ${detail}`, 500);
  }
};

/** 绝对路径判定：POSIX `/…` 或 Windows `C:\…` / `C:/…` */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 把用户传入的相对/绝对路径 resolve 到仓库根内；越界即抛 INVALID_PATH。
 * 说明：按任务要求做 resolve 级校验（不展开符号链接）。
 */
export function resolveInsideRepo(root: string, target: string): string {
  if (typeof target !== "string" || target.trim() === "") {
    throw new HubError(ErrorCodes.INVALID_PATH, "缺少文件路径参数", 400);
  }
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new HubError(ErrorCodes.INVALID_PATH, `路径越出仓库根: ${target}`, 400);
  }
  return abs;
}

/** commit/ref 白名单：字母数字开头，仅允许常见 ref 字符，拒绝 `..` 与前导 `-`（防选项注入） */
const COMMIT_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}+-]{0,99}$/;

export function assertCommitRef(commit: string): void {
  if (typeof commit !== "string" || !COMMIT_RE.test(commit) || commit.includes("..")) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, `非法 commit/ref: ${String(commit).slice(0, 80)}`, 400);
  }
}

/** 输出按字节截断（保 UTF-8 边界：截到最后一个换行） */
export function clampOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let slice = buf.subarray(0, maxBytes);
  const nl = slice.lastIndexOf(0x0a);
  if (nl > 0) slice = slice.subarray(0, nl);
  return { text: slice.toString("utf8"), truncated: true };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间（中文，与 web 端 relativeTime 口径一致） */
export function formatRelativeTime(input: string | number | Date, now: number = Date.now()): string {
  const t = typeof input === "number" ? input : input instanceof Date ? input.getTime() : Date.parse(input);
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 0) return formatAbsolute(t);
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}天前`;
  return formatAbsolute(t);
}

function formatAbsolute(t: number): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** git status --porcelain=v1 解析（状态字母 + 路径，rename 取新路径） */
export function parsePorcelainStatus(text: string): GitDirtyFile[] {
  const out: GitDirtyFile[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    let origPath: string | null = null;
    if (code.includes("R") || code.includes("C")) {
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) {
        origPath = path.slice(0, arrow);
        path = path.slice(arrow + 4);
      }
    }
    path = unquotePath(path.trim());
    origPath = origPath === null ? null : unquotePath(origPath.trim());
    if (path === "") continue;
    out.push({ path, status: code.replace(/\s+/g, "") || "?", origPath });
  }
  return out;
}

/** git 会把含特殊字符的路径用 C 风格引号包起来，尝试 JSON 解引 */
function unquotePath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** git rev-list --left-right --count @{upstream}...HEAD → 左=behind 右=ahead */
export function parseAheadBehind(text: string): { ahead: number; behind: number } {
  const m = text.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return { ahead: 0, behind: 0 };
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

const LOG_SEP = "\u001f";

/** git log --pretty=%h<US>%an<US>%aI<US>%s 解析 */
export function parseLog(text: string, now: number = Date.now()): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(LOG_SEP);
    if (parts.length < 4) continue;
    const [hash, author, authorDate, ...subjectParts] = parts;
    commits.push({
      hash: hash.trim(),
      author: author.trim(),
      authorDate: authorDate.trim(),
      relativeTime: formatRelativeTime(authorDate.trim(), now),
      subject: subjectParts.join(LOG_SEP).trim(),
    });
  }
  return commits;
}

/** git branch --format=%(HEAD)<US>%(refname:short)<US>%(upstream:short) 解析 */
export function parseBranches(text: string): GitBranchInfo[] {
  const branches: GitBranchInfo[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(LOG_SEP);
    if (parts.length < 2) continue;
    const current = (parts[0] ?? "").includes("*");
    const name = (parts[1] ?? "").trim();
    const upstream = (parts[2] ?? "").trim();
    if (name === "") continue;
    branches.push({ name, current, upstream: upstream === "" ? null : upstream });
  }
  return branches;
}

export interface GitApi {
  status(cwd: string): Promise<GitStatusResult>;
  log(cwd: string, limit: number): Promise<GitCommit[]>;
  diff(cwd: string, file: string | null, commit: string | null): Promise<GitDiffResult>;
  branches(cwd: string): Promise<{ branches: GitBranchInfo[]; current: string | null }>;
  fileContent(cwd: string, path: string): Promise<FileContentResult>;
}

/** 校验 cwd：绝对路径 + .git 存在 + rev-parse 出仓库根；失败一律 404 NOT_REPO 信封 */
async function resolveRepoRoot(run: GitRunner, cwd: string): Promise<string> {
  if (typeof cwd !== "string" || cwd.trim() === "" || !isAbsolutePath(cwd)) {
    throw new HubError(ErrorCodes.NOT_REPO, `cwd 必须是绝对路径: ${String(cwd).slice(0, 120)}`, 404);
  }
  const abs = resolve(cwd);
  try {
    await stat(join(abs, ".git")); // 目录（普通仓库）或文件（worktree）
  } catch {
    throw new HubError(ErrorCodes.NOT_REPO, `不是 git 仓库（缺少 .git）: ${abs}`, 404);
  }
  const root = (await run(abs, ["rev-parse", "--show-toplevel"])).trim();
  if (root === "") {
    throw new HubError(ErrorCodes.NOT_REPO, `不是 git 仓库: ${abs}`, 404);
  }
  return root;
}

/** 可注入 runner 的 git API 工厂（测试注入 mock execFile） */
/** git status 缓存：会话列表每行一个徽章请求（36+ 行 = 36+ git 子进程），服务端缓存防雪崩 */
const GIT_STATUS_CACHE_MS = 30_000;

export function createGitApi(runner: GitRunner = runGit): GitApi {
  const statusCache = new Map<string, { at: number; result: GitStatusResult | null; error: unknown }>();
  // 未缓存实现（缓存壳在下面的 status 方法里）
  const runStatus = async (cwd: string): Promise<GitStatusResult> => {
      const root = await resolveRepoRoot(runner, cwd);
      const detachedRaw = (await runner(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      let branch = detachedRaw;
      let detached = false;
      if (detachedRaw === "HEAD" || detachedRaw === "") {
        detached = true;
        branch = (await runner(root, ["rev-parse", "--short", "HEAD"])).trim() || "HEAD";
      }

      let upstream: string | null = null;
      let ahead = 0;
      let behind = 0;
      try {
        upstream = (await runner(root, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim() || null;
      } catch {
        upstream = null; // 无 upstream 不是错误
      }
      if (upstream !== null) {
        try {
          const counts = await runner(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
          ({ ahead, behind } = parseAheadBehind(counts));
        } catch {
          ahead = 0;
          behind = 0;
        }
      }

      const porcelain = await runner(root, ["status", "--porcelain=v1"]);
      const dirty = parsePorcelainStatus(porcelain);
      return {
        cwd,
        root,
        branch,
        detached,
        upstream,
        ahead,
        behind,
        dirty,
        dirtyCount: dirty.length,
      };
  };

  return {
    async status(cwd: string): Promise<GitStatusResult> {
      const hit = statusCache.get(cwd);
      const now = Date.now();
      if (hit && now - hit.at < GIT_STATUS_CACHE_MS) {
        if (hit.error !== null) throw hit.error;
        return hit.result as GitStatusResult;
      }
      try {
        const result = await runStatus(cwd);
        statusCache.set(cwd, { at: now, result, error: null });
        return result;
      } catch (err) {
        // 失败也短缓存（防非仓库路径反复触发 git 子进程）
        statusCache.set(cwd, { at: now, result: null, error: err });
        throw err;
      }
    },

    async log(cwd: string, limit: number): Promise<GitCommit[]> {
      const root = await resolveRepoRoot(runner, cwd);
      const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
      const out = await runner(root, ["log", `-n${n}`, `--pretty=format:%h${LOG_SEP}%an${LOG_SEP}%aI${LOG_SEP}%s`]);
      return parseLog(out);
    },

    async diff(cwd: string, file: string | null, commit: string | null): Promise<GitDiffResult> {
      const root = await resolveRepoRoot(runner, cwd);
      const rel = file === null ? null : relative(root, resolveInsideRepo(root, file));
      if (commit !== null) assertCommitRef(commit);

      // 只读：diff/show/ls-files 都是纯读取；`--` 终止选项解析，路径参数不会被当作 flag
      let raw: string;
      if (commit !== null) {
        raw = await runner(root, ["show", "--no-color", "--format=", "--patch", commit, "--", ...(rel === null ? [] : [rel])]);
      } else {
        raw = await runner(root, ["diff", "--no-color", "HEAD", "--", ...(rel === null ? [] : [rel])]);
        // git diff HEAD 不含未跟踪文件：用 ls-files --others + diff --no-index（只读）补全，
        // 新文件也能在“变更”里看到（上限 20 个，防超大输出）
        const untracked = await runner(root, [
          "ls-files",
          "--others",
          "--exclude-standard",
          ...(rel === null ? [] : ["--", rel]),
        ]);
        const extras: string[] = [];
        for (const u of untracked.split("\n").filter((l) => l.trim() !== "").slice(0, 20)) {
          const d = await runner(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", u], {
            okExitCodes: [0, 1],
          });
          if (d.trim() !== "") extras.push(d);
        }
        if (extras.length > 0) {
          raw = raw.trim() === "" ? extras.join("") : `${raw.trimEnd()}\n${extras.join("")}`;
        }
      }
      const { text, truncated } = clampOutput(raw, MAX_DIFF_BYTES);
      return { root, file: rel, commit, truncated, diff: text };
    },

    async branches(cwd: string): Promise<{ branches: GitBranchInfo[]; current: string | null }> {
      const root = await resolveRepoRoot(runner, cwd);
      const out = await runner(root, ["branch", `--format=%(HEAD)${LOG_SEP}%(refname:short)${LOG_SEP}%(upstream:short)`]);
      const branches = parseBranches(out);
      const current = branches.find((b) => b.current)?.name ?? null;
      return { branches, current };
    },

    async fileContent(cwd: string, path: string): Promise<FileContentResult> {
      const root = await resolveRepoRoot(runner, cwd);
      const abs = resolveInsideRepo(root, path);
      const rel = relative(root, abs);

      let size: number;
      let buf: Buffer;
      const fh = await open(abs, "r").catch(() => {
        throw new HubError(ErrorCodes.FILE_NOT_FOUND, `文件不存在: ${rel}`, 404);
      });
      try {
        const st = await fh.stat();
        if (st.isDirectory()) {
          throw new HubError(ErrorCodes.FILE_NOT_FOUND, `不是文件: ${rel}`, 404);
        }
        size = st.size;
        const want = Math.min(size, MAX_FILE_BYTES);
        buf = Buffer.alloc(want);
        if (want > 0) await fh.read(buf, 0, want, 0);
      } finally {
        await fh.close();
      }

      if (buf.subarray(0, 8192).includes(0)) {
        throw new HubError(ErrorCodes.INVALID_FILE, `二进制文件不支持预览: ${rel}`, 400);
      }
      return {
        root,
        path: rel,
        size,
        truncated: size > MAX_FILE_BYTES,
        content: buf.toString("utf8"),
      };
    },
  };
}
