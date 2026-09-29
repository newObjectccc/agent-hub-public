import type { SessionSummary } from "../api/types";
import { relativeTime } from "../utils/relativeTime";
import { GitStatusBadge } from "./GitStatusBadge";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";

export interface SessionListProps {
  sessions: SessionSummary[];
  onSelect: (session: SessionSummary) => void;
  /** 可注入"现在"时间便于测试 */
  now?: number;
}

/** 按 updatedAt 倒序排列（与契约一致），非法时间排最后 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.slice().sort((a, b) => {
    const ta = Date.parse(a.updatedAt);
    const tb = Date.parse(b.updatedAt);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });
}

function summaryOf(s: SessionSummary): string {
  return s.lastAssistantMessage ?? s.lastUserMessage ?? "暂无对话内容";
}

/** 标题优先级：会话 name > 文件夹名（basename(cwd)）> id 前缀 */
function titleOf(s: SessionSummary): string {
  if (s.name && s.name.trim() !== "") return s.name.trim();
  const base = s.cwd.replace(/[\\/]$/, "").split(/[\\/]/).filter(Boolean).pop();
  return base && base !== "" ? base : s.id.slice(0, 8);
}

/** 路径缩写：$HOME → ~，只用于副标题（完整路径在 title 提示/详情中查看） */
function shortPath(cwd: string): string {
  // 把 /Users/<user> 或 /home/<user> 前缀缩为 ~
  return cwd.replace(/^\/(Users|home)\/[^/]+/, "~");
}

/** 会话列表：标题（name>文件夹名）、缩写路径、状态徽章、最后对话摘要、相对时间 */
export function SessionList({ sessions, onSelect, now }: SessionListProps) {
  const sorted = sortSessions(sessions);
  return (
    <div className="session-list" role="list">
      {sorted.map((s) => (
        <Button
          key={s.id}
          type="button"
          role="listitem"
          className="session-item"
          onClick={() => onSelect(s)}
        >
          <div className="session-head">
            <span className="session-name" title={s.name && s.name.trim() !== "" ? s.name : s.cwd}>
              {titleOf(s)}
            </span>
            <StatusBadge status={s.status} />
            <span className="session-time">{relativeTime(s.updatedAt, now)}</span>
          </div>
          <div className="session-cwd" title={s.cwd}>
            {shortPath(s.cwd)}
          </div>
          {/* git 状态条：🌿 分支 · ↑2 ↓0 · ⚠3 files（非 git 仓库自动隐藏） */}
          <GitStatusBadge cwd={s.cwd} compact />
          <div className="session-summary">{summaryOf(s)}</div>
        </Button>
      ))}
    </div>
  );
}
