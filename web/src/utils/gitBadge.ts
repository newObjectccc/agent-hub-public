/**
 * git 状态徽章文案（纯函数，测试用）：🌿 分支 · ↑ahead ↓behind · ⚠n files
 */
import type { GitStatusResult } from "../api/types";

export interface GitChip {
  key: "branch" | "counts" | "dirty" | "clean" | "detached";
  label: string;
  tone: "branch" | "plain" | "warn" | "ok";
}

export function gitStatusChips(status: GitStatusResult): GitChip[] {
  const chips: GitChip[] = [
    { key: "branch", label: `🌿 ${status.branch}`, tone: "branch" },
    { key: "counts", label: `↑${status.ahead} ↓${status.behind}`, tone: "plain" },
    status.dirtyCount > 0
      ? { key: "dirty", label: `⚠${status.dirtyCount} files`, tone: "warn" }
      : { key: "clean", label: "✓ clean", tone: "ok" },
  ];
  if (status.detached) chips.push({ key: "detached", label: "detached", tone: "warn" });
  return chips;
}

/** 一行文案（无障碍/测试断言用） */
export function gitStatusText(status: GitStatusResult): string {
  return gitStatusChips(status)
    .map((c) => c.label)
    .join(" · ");
}
