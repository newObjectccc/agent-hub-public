import type { MutableRefObject } from "react";
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
  /** 排序优先级注入（等你处理 > 工作中 > 其他），不传保持纯 updatedAt 倒序 */
  priority?: SessionSortPriority;
  /** 运行中会话起点毫秒时间戳（id → startedAt），提供时行内显示“已运行 X 分钟”实时标记 */
  runningSince?: ReadonlyMap<string, number>;
}

/**
 * 排序优先级注入（参考 filterSessionsByTab 的 id 集合传递方式）：
 * 等你处理（attentionIds）> 工作中（isRunning）> 其他。
 */
export interface SessionSortPriority {
  /** 等你处理会话 id（来自 dashboard stats 的 attentionSessions） */
  attentionIds?: ReadonlySet<string>;
  /** 运行中判定注入（HomePage 注入 s.status === "running"） */
  isRunning?: (s: SessionSummary) => boolean;
}

function priorityRank(s: SessionSummary, priority: SessionSortPriority): number {
  if (priority.attentionIds?.has(s.id)) return 0;
  if (priority.isRunning?.(s)) return 1;
  return 2;
}

/**
 * 按优先级（等你处理 > 工作中 > 其他）分组，组内 updatedAt 倒序（与契约一致），非法时间排最后。
 * 同时间用 id 升序确定性 tiebreaker：无论输入顺序，输出顺序唯一，刷新绝不重排（AC3-a）。
 * 不传 priority 时退化为纯 updatedAt 倒序（旧行为保持不变）。
 */
export function sortSessions(sessions: SessionSummary[], priority: SessionSortPriority = {}): SessionSummary[] {
  return sessions.slice().sort((a, b) => {
    const ra = priorityRank(a, priority);
    const rb = priorityRank(b, priority);
    if (ra !== rb) return ra - rb;
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
 * 会话列表：标题（name>文件夹名）、缩写路径、来源徽章、git 状态、状态徽章、摘要、相对时间。
 * 虚拟滚动（固定行高窗口化）× 动画克制（进场只播首次插入，key 稳定 s.id）。
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
  // “已运行 X 分钟”实时标记：存在带起点的运行中会话才挂滴答（刷新不重排不闪，仅文字跳动）
  const hasRunning = sorted.some((s) => s.status === "running" && runningSince?.has(s.id));
  const tickNow = useNowTicker(now === undefined && hasRunning);
  const nowMs = now ?? tickNow;
  return (
    <VirtualList
      items={sorted}
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
        <div className="session-row">
          <Button
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
              <SourceBadge source={s.source} />
              <StatusBadge status={s.status} />
              {s.status === "running" && runningSince?.has(s.id) && (
                <span className="session-elapsed">已运行 {elapsedMinutesLabel(runningSince.get(s.id)!, nowMs)}</span>
              )}
              <span className="session-time">{relativeTime(s.updatedAt, nowMs)}</span>
            </div>
            <div className="session-cwd" title={s.cwd}>
              {shortPath(s.cwd)}
            </div>
            {/* git 状态条：🌿 分支 · ↑2 ↓0 · ⚠3 files（非 git 仓库自动隐藏） */}
            <GitStatusBadge cwd={s.cwd} compact />
            <div className="session-summary">{summaryOf(s)}</div>
          </Button>
        </div>
      )}
    />
  );
}
