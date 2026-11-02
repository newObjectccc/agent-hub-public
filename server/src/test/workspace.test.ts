import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WorkspaceService, parseWorkspaceRevision } from "../workspace.js";
import { createApp } from "../index.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
import type { SessionHubLike } from "../routes.js";
import type { SessionListItem, SystemInfo } from "../types.js";

let dir: string, repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "hub-workspace-")));
  repo = join(dir, "actual-project"); await mkdir(repo);
  git(repo, "init", "-b", "main"); await writeFile(join(repo, "a.txt"), "first");
  git(repo, "add", "."); git(repo, "commit", "-m", "first");
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("live workspace identity", () => {
  it("handles subdirectories and linked worktrees without naming a project after the worktree folder", async () => {
    const sub = join(repo, "src"); await mkdir(sub);
    const linked = join(dir, "random-worktree-name"); git(repo, "worktree", "add", "-b", "fix/mobile", linked);
    const service = new WorkspaceService();
    const a = await service.inspect(sub, true), b = await service.inspect(linked, true);
    assert.equal(a.projectName, "actual-project"); assert.equal(a.branch, "main"); assert.equal(a.root, repo);
    assert.equal(b.projectName, "actual-project"); assert.equal(b.isWorktree, true); assert.equal(b.repositoryRoot, repo);
    assert.equal(b.branch, "fix/mobile"); assert.notEqual(a.revision, b.revision);
  });
  it("fresh admission checks reject a branch switch despite a warm list cache, but accept a new commit on the same branch", async () => {
    const service = new WorkspaceService(); const first = await service.inspect(repo);
    await writeFile(join(repo, "a.txt"), "second"); git(repo, "add", "."); git(repo, "commit", "-m", "second");
    await service.assert(repo, first.revision!);
    git(repo, "checkout", "-b", "release/beta.4");
    assert.equal((await service.inspect(repo)).branch, "main");
    await assert.rejects(service.assert(repo, first.revision!), (e: { code?: string }) => e.code === "WORKSPACE_CHANGED");
    assert.equal((await service.inspect(repo, true)).branch, "release/beta.4");
    git(repo, "checkout", "main");
  });
  it("distinguishes detached commits and an unborn branch", async () => {
    const service = new WorkspaceService();
    git(repo, "checkout", "--detach", "HEAD"); const current = await service.inspect(repo, true);
    assert.equal(current.detached, true); assert.equal(current.branch, null); assert.equal(current.head, git(repo, "rev-parse", "HEAD"));
    git(repo, "checkout", "--detach", "HEAD~1");
    await assert.rejects(service.assert(repo, current.revision!), (e: { code?: string }) => e.code === "WORKSPACE_CHANGED");
    git(repo, "checkout", "main");
    const empty = join(dir, "empty"); await mkdir(empty); git(empty, "init", "-b", "new-branch");
    const unborn = await service.inspect(empty, true); assert.equal(unborn.branch, "new-branch"); assert.ok(unborn.revision);
  });
  it("represents a plain directory separately from a missing/unreadable workspace", async () => {
    const plain = await new WorkspaceService().inspect(dir, true);
    assert.equal(plain.kind, "directory"); assert.equal(plain.projectName, basename(dir)); assert.ok(plain.revision);
    const missing = await new WorkspaceService().inspect(join(dir, "missing"), true);
    assert.equal(missing.kind, "unavailable"); assert.equal(missing.revision, null);
    await assert.rejects(new WorkspaceService().assert(missing.cwd, plain.revision!), (e: { code?: string }) => e.code === "WORKSPACE_UNAVAILABLE");
    assert.throws(() => parseWorkspaceRevision(null)); assert.throws(() => parseWorkspaceRevision("main"));
  });
  it("does not make Git an installation requirement for plain directories", async () => {
    const missingGit = new WorkspaceService(async () => { throw Object.assign(new Error("not installed"), { code: "ENOENT" }); });
    assert.equal((await missingGit.inspect(dir, true)).kind, "directory");
    assert.equal((await missingGit.inspect(repo, true)).kind, "unavailable");
  });
});

describe("workspace admission routes", () => {
  async function fixture(locked = false) {
    let prompts = 0;
    const session = { id: "session", source: "codex", cwd: repo, name: null, sessionFile: join(repo, "session.jsonl"), updatedAt: new Date().toISOString(), messageCount: 0, status: "idle", lastUserMessage: null, lastAssistantMessage: null, isSubAgent: false } as SessionListItem;
    const hub: SessionHubLike = { getStatus: () => "idle", listSessions: async () => [session], findSession: async () => session,
      loadMessages: async () => [], loadTree: async () => null, search: async () => [], createSession: async () => session, forkSession: async () => session,
      prompt: async () => { prompts++; return { accepted: true, mode: "prompt" }; }, abort: async () => {}, compact: async () => {} };
    const app = await createApp({ hub, kpi: { getCards: () => [] }, dashboard: makeFakeDashboard(), config: DEFAULT_CONFIG,
      panelDriven: { has: () => false, mark: async () => {} },
      systemInfo: async () => ({} as SystemInfo), webRoot: null,
      appLock: { ...fakeUnlockedAppLock(), status: () => ({ configured: locked, webauthn: false, expiresAt: null }) },
    });
    return { app, prompts: () => prompts };
  }
  it("uses the same fresh guard for prompt and takeover; a rejection never executes or falls back", async () => {
    const { app, prompts } = await fixture();
    try {
      const response = await app.inject({ url: `/api/workspace?cwd=${encodeURIComponent(repo)}` });
      assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
      const revision = response.json().revision as string;
      git(repo, "checkout", "-b", "fix/admission");
      for (const path of ["prompt", "message"]) {
        const rejected = await app.inject({ method: "POST", url: `/api/sessions/session/${path}`, payload: { text: "must not run", workspaceRevision: revision } });
        assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "WORKSPACE_CHANGED");
      }
      assert.equal(prompts(), 0); git(repo, "checkout", "main");
      const accepted = await app.inject({ method: "POST", url: "/api/sessions/session/prompt", payload: { text: "ok", workspaceRevision: revision, clientMessageId: "one" } });
      assert.equal(accepted.statusCode, 202); assert.equal(prompts(), 1);
      git(repo, "checkout", "fix/admission");
      const replayed = await app.inject({ method: "POST", url: "/api/sessions/session/prompt", payload: { text: "ok", workspaceRevision: revision, clientMessageId: "one" } });
      assert.equal(replayed.statusCode, 202); assert.equal(prompts(), 1); git(repo, "checkout", "main");
    } finally { await app.close(); }
  });
  it("keeps the workspace endpoint behind the existing application lock", async () => {
    const { app } = await fixture(true);
    try { assert.equal((await app.inject({ url: `/api/workspace?cwd=${encodeURIComponent(repo)}` })).statusCode, 423); }
    finally { await app.close(); }
  });
});
