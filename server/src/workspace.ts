/** Read-only workspace identity. Fresh checks deliberately bypass the list cache. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { ErrorCodes, HubError } from "./errors.js";
import type { WorkspaceSnapshot } from "./types.js";

const exec = promisify(execFile);
type Runner = (cwd: string, args: string[]) => Promise<string>;
async function hasGitAncestor(cwd: string): Promise<boolean> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try { await stat(resolve(dir, ".git")); return true; }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") return true; }
    if (dirname(dir) === dir) return false;
  }
}
const run: Runner = async (cwd, args) => (await exec("git", args, {
  cwd, timeout: 4_000, maxBuffer: 128 * 1024, windowsHide: true,
  env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
})).stdout;

export function parseWorkspaceRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "workspaceRevision 必须是工作区接口返回的版本标识", 400);
  }
  return value;
}

export class WorkspaceService {
  private readonly cache = new Map<string, { at: number; value: Promise<WorkspaceSnapshot> }>();
  constructor(private readonly runner: Runner = run) {}

  inspect(cwd: string, fresh = false): Promise<WorkspaceSnapshot> {
    if (!isAbsolute(cwd) && !/^[A-Za-z]:[\\/]/.test(cwd)) {
      throw new HubError(ErrorCodes.INVALID_CWD, "cwd 必须是绝对路径", 400);
    }
    if (fresh) return this.read(cwd);
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = this.read(cwd);
    this.cache.delete(cwd);
    this.cache.set(cwd, { at: Date.now(), value });
    while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  async assert(cwd: string, expected: string | undefined): Promise<void> {
    if (expected === undefined) return; // Backwards compatible with older clients.
    const current = await this.inspect(cwd, true);
    if (current.revision === null) throw new HubError(ErrorCodes.WORKSPACE_UNAVAILABLE, "暂时无法确认工作区，请核对后重试", 409);
    if (current.revision !== expected) throw new HubError(ErrorCodes.WORKSPACE_CHANGED, "工作目录或 Git 分支已变更，消息尚未发送，请核对工作区后重试", 409);
  }

  private async read(cwd: string): Promise<WorkspaceSnapshot> {
    const result: WorkspaceSnapshot = {
      cwd, projectName: basename(resolve(cwd)) || cwd, root: null, repositoryRoot: null,
      isWorktree: false, branch: null, head: null, detached: false, kind: "unavailable", revision: null,
    };
    try {
      const canonical = await realpath(cwd);
      let roots: string;
      try {
        roots = await this.runner(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"]);
      } catch (error) {
        const notRepo = /not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ""));
        const noGitInPlainDirectory = (error as { code?: string }).code === "ENOENT" && !(await hasGitAncestor(canonical));
        if (!notRepo && !noGitInPlainDirectory) return result;
        result.kind = "directory";
        result.revision = this.revision([canonical, "directory"]);
        return result;
      }
      const [root, common, gitDir] = roots.trim().split(/\r?\n/);
      if (!root || !common || !gitDir) return result;
      result.root = root;
      result.isWorktree = resolve(common) !== resolve(gitDir);
      result.repositoryRoot = basename(common) === ".git" ? dirname(common) : root;
      result.projectName = basename(result.repositoryRoot) || result.projectName;
      // symbolic-ref still succeeds in an empty repository (unborn HEAD).
      let branch: string | null = null;
      try { branch = (await this.runner(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null; }
      catch (error) { if ((error as { code?: unknown }).code !== 1) return result; }
      let head: string | null = null;
      if (branch === null) head = (await this.runner(cwd, ["rev-parse", "--verify", "HEAD"])).trim() || null;
      if (branch === null && !head) return result;
      result.kind = "git"; result.branch = branch; result.head = head; result.detached = branch === null;
      // New commits/dirty files on the same branch don't require another confirmation.
      result.revision = this.revision([canonical, root, common, branch === null ? `HEAD:${head}` : `branch:${branch}`]);
      return result;
    } catch { return result; } // No stale or invented branch on git/network/filesystem errors.
  }

  private revision(parts: string[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
}
