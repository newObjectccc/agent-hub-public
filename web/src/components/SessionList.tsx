import type { SessionSummary } from "../api/types";
import { relativeTime } from "../utils/relativeTime";
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

/** 会话列表：name、cwd、状态徽章、最后对话摘要、相对时间 */
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
            <span className="session-name">{s.name}</span>
            <StatusBadge status={s.status} />
            <span className="session-time">{relativeTime(s.updatedAt, now)}</span>
          </div>
          <div className="session-cwd" title={s.cwd}>
            {s.cwd}
          </div>
          <div className="session-summary">{summaryOf(s)}</div>
        </Button>
      ))}
    </div>
  );
}
