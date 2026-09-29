import type { SessionSummary } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { sessionTitle, shortPath } from "../utils/display";
import { relativeTime } from "../utils/relativeTime";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

export interface SessionListProps {
  sessions: SessionSummary[];
  onSelect: (session: SessionSummary) => void;
  /** 可注入"现在"时间便于测试 */
  now?: number;
}

/**
 * 按 updatedAt 倒序排列（与契约一致），非法时间排最后。
 * 同一时间用 id 升序做确定性 tiebreaker：无论输入顺序如何，输出顺序唯一，
 * 刷新/重渲染绝不重排（用户硬要求）。
 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.slice().sort((a, b) => {
    const ta = Date.parse(a.updatedAt);
    const tb = Date.parse(b.updatedAt);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    if (vb !== va) return vb - va;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function summaryOf(s: SessionSummary): string {
  return s.lastAssistantMessage ?? s.lastUserMessage ?? "暂无对话内容";
}

/**
 * 会话列表：标题（name>文件夹名）、缩写路径、状态徽章、最后对话摘要、相对时间。
 * 动画克制：key 稳定用 s.id，进场动画只播「首次插入」的条目（useFirstSeen），
 * 数据刷新/重新渲染/tab 切换均零动画；排序固定 updatedAt 倒序（稳定不重排）。
 */
export function SessionList({ sessions, onSelect, now }: SessionListProps) {
  const sorted = sortSessions(sessions);
  const newIds = useFirstSeen(sorted.map((s) => s.id));
  return (
    <div className="session-list" role="list">
      {sorted.map((s, index) => (
        <Button
          key={s.id}
          type="button"
          role="listitem"
          className={cn("session-item", newIds.has(s.id) && "enter")}
          style={newIds.has(s.id) ? { animationDelay: `${Math.min(index, 6) * 30}ms` } : undefined}
          onClick={() => onSelect(s)}
        >
          <div className="session-head">
            <span className="session-name" title={s.name && s.name.trim() !== "" ? s.name : s.cwd}>
              {sessionTitle(s)}
            </span>
            <StatusBadge status={s.status} />
            <span className="session-time">{relativeTime(s.updatedAt, now)}</span>
          </div>
          <div className="session-cwd" title={s.cwd}>
            {shortPath(s.cwd)}
          </div>
          <div className="session-summary">{summaryOf(s)}</div>
        </Button>
      ))}
    </div>
  );
}
