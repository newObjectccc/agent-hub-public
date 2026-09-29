import type { MutableRefObject } from "react";
import { useState } from "react";
import type { SessionSummary } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { useNowTicker } from "../hooks/useNowTicker";
import { sessionTitle, shortPath } from "../utils/display";
import { elapsedMinutesLabel, relativeTime } from "../utils/relativeTime";
import { GitStatusBadge } from "./GitStatusBadge";
import { SourceBadge } from "./SourceBadge";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";
import { VirtualList } from "./VirtualList";
import { cn } from "@/lib/utils";

/** 固定行高（px，含 12px 行间距），必须与 CSS .session-row 高度一致 */
export const SESSION_ITEM_HEIGHT = 150;

/** 排序优先级注入：等你处理（attentionIds）> 工作中（isRunning）> 其他 */
export interface SessionSortPriority {
  attentionIds?: ReadonlySet<string>;
  isRunning?: (s: SessionSummary) => boolean;
}

export interface SessionListProps {
  sessions: SessionSummary[];
  onSelect: (session: SessionSummary) => void;
  /** 可注入"现在"时间便于测试 */
  now?: number;
  /** 注入视口高度（测试）；缺省由滚动容器自测 */
  viewportHeight?: number;
  /** 滚动容器引用（列表 scrollTop 记忆 / 下拉刷新到顶判定） */
  scrollRef?: MutableRefObject<HTMLDivElement | null>;
  /** 恢复的列表滚动位置 */
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
  /** 跨卸载持久的 seen 容器（空分类 tab 往返不重播进场动画，AC3-b） */
  seenIds?: Set<string>;
  /** 排序优先级（缺省纯时间序，旧行为零变化） */
  priority?: SessionSortPriority;
  /** 会话运行起点（行内"已运行 X 分钟"实时标记） */
  runningSince?: Map<string, number>;
}

function priorityRank(s: SessionSummary, priority?: SessionSortPriority): number {
  if (priority?.attentionIds?.has(s.id)) return 0;
  if (priority?.isRunning?.(s)) return 1;
  return 2;
}

/**
 * 排序（与契约一致）：
 * 1) 等你处理 > 工作中 > 其他（priorityRank）
 * 2) 主会话排前、子代理组整体靠后（isSubAgent）
 * 3) 组内 updatedAt 倒序 + id 升序确定性 tiebreaker（AC3-a：刷新绝不重排）
 */
export function sortSessions(sessions: SessionSummary[], priority?: SessionSortPriority): SessionSummary[] {
  return sessions.slice().sort((a, b) => {
    const ra = priorityRank(a, priority);
    const rb = priorityRank(b, priority);
    if (ra !== rb) return ra - rb;
    const subA = a.isSubAgent === true ? 1 : 0;
    const subB = b.isSubAgent === true ? 1 : 0;
    if (subA !== subB) return subA - subB;
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

function isSubAgent(s: SessionSummary): boolean {
  return s.isSubAgent === true;
}

interface SessionRowProps {
  session: SessionSummary;
  index: number;
  isNew: boolean;
  now?: number;
  runningSince?: Map<string, number>;
  onSelect: (session: SessionSummary) => void;
}

/** 单行会话（主列表与子代理分组共用） */
function SessionRow({ session: s, index, isNew, now, runningSince, onSelect }: SessionRowProps) {
  const nowMs = now ?? Date.now();
  const startedAt = runningSince?.get(s.id);
  return (
    <div className="session-row">
      <Button
        type="button"
        role="listitem"
        className={cn("session-item", isNew && "enter")}
        style={isNew ? { animationDelay: `${Math.min(index, 6) * 30}ms` } : undefined}
        onClick={() => onSelect(s)}
      >
        <div className="session-head">
          <span className="session-name" title={s.name && s.name.trim() !== "" ? s.name : s.cwd}>
            {sessionTitle(s)}
          </span>
          <SourceBadge source={s.source} />
          {isSubAgent(s) && (
            <span className="badge subagent" title="pi-subagents 派生的子代理会话">
              🤖
            </span>
          )}
          <StatusBadge status={s.status} />
          {s.status === "running" && startedAt !== undefined && (
            <span className="session-elapsed">已运行 {elapsedMinutesLabel(startedAt, nowMs)}</span>
          )}
          <span className="session-time">{relativeTime(s.updatedAt, now)}</span>
        </div>
        <div className="session-cwd" title={s.cwd}>
          {shortPath(s.cwd)}
        </div>
        {/* git 状态条：🌿 分支 · ↑2 ↓0 · ⚠3 files（非 git 仓库自动隐藏） */}
        <GitStatusBadge cwd={s.cwd} compact />
        <div className="session-summary">{summaryOf(s)}</div>
      </Button>
    </div>
  );
}

/**
 * 会话列表：虚拟滚动（固定行高窗口化）× 动画克制（进场只播首次插入）×
 * 优先级排序（等你处理>工作中>其他）× 子代理分组折叠（主会话排前）。
 */
export function SessionList({
  sessions,
  onSelect,
  now,
  viewportHeight,
  scrollRef,
  initialScrollTop,
  onScrollTop,
  seenIds,
  priority,
  runningSince,
}: SessionListProps) {
  const sorted = sortSessions(sessions, priority);
  const newIds = useFirstSeen(sorted.map((s) => s.id), seenIds);
  const mainSessions = sorted.filter((s) => !isSubAgent(s));
  const subSessions = sorted.filter(isSubAgent);
  const [subOpen, setSubOpen] = useState(false);
  return (
    <>
      <VirtualList
        items={mainSessions}
        itemHeight={SESSION_ITEM_HEIGHT}
        getKey={(s) => s.id}
        className="session-list-scroll"
        innerClassName="session-list"
        role="list"
        viewportHeight={viewportHeight}
        scrollRef={scrollRef}
        initialScrollTop={initialScrollTop}
        onScrollTop={onScrollTop}
        renderItem={(s, index) => (
          <SessionRow
            session={s}
            index={index}
            isNew={newIds.has(s.id)}
            now={now}
            runningSince={runningSince}
            onSelect={onSelect}
          />
        )}
      />
      {subSessions.length > 0 && (
        <div className="subagent-group">
          <button
            type="button"
            className="subagent-toggle"
            aria-expanded={subOpen}
            onClick={() => setSubOpen((v) => !v)}
          >
            <span>🤖 子代理 ({subSessions.length})</span>
            <span className="subagent-caret">{subOpen ? "收起 ▴" : "展开 ▾"}</span>
          </button>
          {subOpen && (
            <div className="session-list subagent-list" role="list">
              {subSessions.map((s, index) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  index={index}
                  isNew={newIds.has(s.id)}
                  now={now}
                  runningSince={runningSince}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
