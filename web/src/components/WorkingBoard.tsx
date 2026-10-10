/**
 * 运行看板：🔥 工作中 的实时进度卡。
 * 数据来自 /api/dashboard/stats 的 workingSessions（running 状态 + WS status 事件驱动刷新），
 * 已运行时长用本地时钟实时跳动。
 */
import type { WorkingSessionCard } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { useNowTicker } from "../hooks/useNowTicker";
import { sessionTitle, shortPath } from "../utils/display";
import { elapsedDuration, relativeTime } from "../utils/relativeTime";
import { SourceBadge } from "./SourceBadge";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";


export function WorkingCard({
  card,
  onSelect,
  now,
  enter = false,
  index = 0,
}: {
  card: WorkingSessionCard;
  onSelect: (id: string) => void;
  now: number;
  /** 仅新插入条目播一次性进场动画 */
  enter?: boolean;
  index?: number;
}) {
  const startedAt = card.startedAt ? Date.parse(card.startedAt) : NaN;
  return (
    <Button
      type="button"
      className={cn("session-item working-card", enter && "enter")}
      style={enter ? { animationDelay: `${Math.min(index, 6) * 30}ms` } : undefined}
      onClick={() => onSelect(card.id)}
    >
      <div className="session-head">
        <span className="session-name" title={card.cwd}>
          {sessionTitle(card)}
        </span>
        <SourceBadge source={card.source} />
        <span className="badge running">运行中</span>
        <span className="session-time">
          {Number.isFinite(startedAt) ? `已运行 ${elapsedDuration(startedAt, now)}` : relativeTime(card.updatedAt, now)}
        </span>
      </div>
      <div className="session-cwd" title={card.cwd}>
        {shortPath(card.cwd)}
      </div>
      {card.currentTool && (
        <div className="working-tool">
          <span aria-hidden>⚙</span>
          <span className="working-tool-summary" title={card.currentTool}>
            {card.currentTool}
          </span>
        </div>
      )}
      {card.lastOutput && <div className="session-summary">{card.lastOutput}</div>}
    </Button>
  );
}

export function WorkingBoard({
  sessions,
  onSelect,
}: {
  sessions: WorkingSessionCard[];
  onSelect: (id: string) => void;
}) {
  const now = useNowTicker(sessions.length > 0);
  const newIds = useFirstSeen(sessions.map((c) => c.id));
  return (
    <div className="session-list" role="list" aria-label="工作中会话">
      {sessions.map((card, index) => (
        <WorkingCard
          key={card.id}
          card={card}
          onSelect={onSelect}
          now={now}
          enter={newIds.has(card.id)}
          index={index}
        />
      ))}
    </div>
  );
}
