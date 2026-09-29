/**
 * ⚠️ 等你处理：settled（agent 干完等你输入）/ error（出错）的会话卡。
 * 点击进入会话继续处理。
 */
import type { AttentionSessionCard } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { sessionTitle, shortPath } from "../utils/display";
import { relativeTime } from "../utils/relativeTime";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

export function AttentionList({
  sessions,
  onSelect,
  now,
}: {
  sessions: AttentionSessionCard[];
  onSelect: (id: string) => void;
  now?: number;
}) {
  const newIds = useFirstSeen(sessions.map((c) => c.id));
  return (
    <div className="session-list" role="list" aria-label="等你处理会话">
      {sessions.map((card, index) => (
        <Button
          key={card.id}
          type="button"
          className={cn("session-item attention-card", newIds.has(card.id) && "enter")}
          style={newIds.has(card.id) ? { animationDelay: `${Math.min(index, 6) * 30}ms` } : undefined}
          onClick={() => onSelect(card.id)}
        >          <div className="session-head">
            <span className="session-name" title={card.cwd}>
              {sessionTitle(card)}
            </span>
            <span className={`badge ${card.reason === "error" ? "error" : "settled"}`}>
              {card.reason === "error" ? "出错了" : "干完了"}
            </span>
            <span className="session-time">{relativeTime(card.updatedAt, now)}</span>
          </div>
          <div className="session-cwd" title={card.cwd}>
            {shortPath(card.cwd)}
          </div>
          {card.summary && <div className="session-summary">{card.summary}</div>}
        </Button>
      ))}
    </div>
  );
}
