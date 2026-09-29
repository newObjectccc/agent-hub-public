/**
 * git 状态条：🌿 分支 · ↑2 ↓0 · ⚠3 files（野兽派小徽章行）。
 * 会话卡片/chat 顶栏复用；onClick 提供时渲染为可点按钮（打开 Git 面板）。
 */
import { useGitStatus } from "../hooks/useGitStatus";
import { gitStatusChips } from "../utils/gitBadge";

export interface GitStatusBadgeProps {
  cwd: string;
  /** 紧凑模式（会话卡片）：字号更小 */
  compact?: boolean;
  onClick?: () => void;
}

export function GitStatusBadge({ cwd, compact, onClick }: GitStatusBadgeProps) {
  const status = useGitStatus(cwd);
  if (!status) return null;
  const chips = gitStatusChips(status).map((chip) => (
    <span key={chip.key} className={`git-chip ${chip.tone}`}>
      {chip.label}
    </span>
  ));
  const cls = `git-bar${compact ? " compact" : ""}`;
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} aria-label="查看 git 变更">
        {chips}
      </button>
    );
  }
  return (
    <div className={cls} role="status" aria-label="git 状态">
      {chips}
    </div>
  );
}
