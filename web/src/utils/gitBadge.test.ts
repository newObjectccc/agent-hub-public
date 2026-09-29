/**
 * git 状态徽章文案单测。
 */
import { describe, expect, it } from "vitest";
import type { GitStatusResult } from "../api/types";
import { gitStatusChips, gitStatusText } from "./gitBadge";

const base: GitStatusResult = {
  cwd: "/Users/me/Workspace/demo",
  root: "/Users/me/Workspace/demo",
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  dirty: [],
  dirtyCount: 3,
};

describe("gitStatusText / gitStatusChips", () => {
  it("🌿 分支 · ↑ahead ↓behind · ⚠n files", () => {
    expect(gitStatusText(base)).toBe("🌿 main · ↑2 ↓0 · ⚠3 files");
  });

  it("工作区干净时显示 ✓ clean", () => {
    expect(gitStatusText({ ...base, dirtyCount: 0 })).toContain("✓ clean");
  });

  it("detached HEAD 追加 detached 标记", () => {
    const chips = gitStatusChips({ ...base, detached: true, branch: "abc1234" });
    expect(chips.map((c) => c.key)).toContain("detached");
    expect(gitStatusText({ ...base, detached: true, branch: "abc1234" })).toContain("🌿 abc1234");
  });
});
