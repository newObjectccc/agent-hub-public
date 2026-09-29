import type { MutableRefObject } from "react";
import { useState } from "react";
import type { SessionSummary } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { useIsMobile } from "../hooks/useIsMobile";
import { useNowTicker } from "../hooks/useNowTicker";
import { sessionTitle, shortPath } from "../utils/display";
import { elapsedMinutesLabel, relativeTime } from "../utils/relativeTime";
import { groupSessions, loadExpanded, saveExpanded } from "../utils/sessionTree";
import { GitStatusBadge } from "./GitStatusBadge";
import { SourceBadge } from "./SourceBadge";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";
import { VirtualList } from "./VirtualList";
import { cn } from "@/lib/utils";

/** 标准密度主行高（px，含 10px 行间距），必须与 CSS .session-row 高度一致 */
export const SESSION_ITEM_HEIGHT = 128;
/** 移动端密度（<768px）主行高（含 8px 行间距） */
export const SESSION_ITEM_HEIGHT_MOBILE = 112;
/** 子代理子行高（含行间距）：标准 / 移动 */
export const SESSION_CHILD_HEIGHT = 76;
export const SESSION_CHILD_HEIGHT_MOBILE = 66;

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
 * 1) 等你处理 > 工作中 > 其他（priorityRank，任意 tab 均生效，含"全部"）
 * 2) 子代理跟随父会话：已归组子代理（parentSessionId 命中列表内主会话）不单独占
 *    优先级位，排序键取父会话的；同组内主行在前、子代理按 updatedAt desc + id
 * 3) 未归组子代理整体靠后（主会话排前，R3 行为不变）
 * 4) 组内 updatedAt 倒序 + id 升序确定性 tiebreaker（AC3-a：刷新绝不重排）
 */
export function sortSessions(sessions: SessionSummary[], priority?: SessionSortPriority): SessionSummary[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  /** 排序锚点：已归组子代理 → 父会话；其余 → 自身 */
  const anchorOf = (s: SessionSummary): SessionSummary => {
    if (s.isSubAgent === true) {
      const parentId = s.parentSessionId ?? null;
      const parent = parentId !== null ? byId.get(parentId) : undefined;
      if (parent && parent !== s && parent.isSubAgent !== true) return parent;
    }
    return s;
  };
  const anchorTime = (s: SessionSummary): number => {
    const t = Date.parse(s.updatedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return sessions.slice().sort((a, b) => {
    const anchorA = anchorOf(a);
    const anchorB = anchorOf(b);
    const ra = priorityRank(anchorA, priority);
    const rb = priorityRank(anchorB, priority);
    if (ra !== rb) return ra - rb;
    if (anchorA === anchorB) {
      // 同组：主行在前，子代理组内 updatedAt desc + id tiebreaker
      const subA = a === anchorA ? 0 : 1;
      const subB = b === anchorB ? 0 : 1;
      if (subA !== subB) return subA - subB;
      const va = anchorTime(a);
      const vb = anchorTime(b);
      if (vb !== va) return vb - va;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    // 跨组：主会话整体排前（未归组子代理靠后），组间按锚点 updatedAt desc + id
    const orphanA = anchorA.isSubAgent === true ? 1 : 0;
    const orphanB = anchorB.isSubAgent === true ? 1 : 0;
    if (orphanA !== orphanB) return orphanA - orphanB;
    const va = anchorTime(anchorA);
    const vb = anchorTime(anchorB);
    if (vb !== va) return vb - va;
    return anchorA.id < anchorB.id ? -1 : anchorA.id > anchorB.id ? 1 : 0;
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

/** 单行会话（主列表与子代理行共用） */
function SessionRow({ session: s, index, isNew, now, runningSince, onSelect }: SessionRowProps) {
  const nowMs = now ?? Date.now();
  const startedAt = runningSince?.get(s.id);
  return (
    <div className={cn("session-row", isSubAgent(s) && "sub-row")}>
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
 * 会话列表：虚拟滚动（可变行高窗口化：树形展开行高可变）× 动画克制（进场只播首次插入）×
 * 优先级排序（等你处理>工作中>其他，全 tab 生效）× 子代理树形（主行展开子行缩进，
 * 折叠状态 localStorage 持久）× 未归组子代理兜底折叠分组（R3 行为保留）。
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
  const isMobile = useIsMobile();
  const mainHeight = isMobile ? SESSION_ITEM_HEIGHT_MOBILE : SESSION_ITEM_HEIGHT;
  const childHeight = isMobile ? SESSION_CHILD_HEIGHT_MOBILE : SESSION_CHILD_HEIGHT;
  const sorted = sortSessions(sessions, priority);
  const newIds = useFirstSeen(sorted.map((s) => s.id), seenIds);
  const { roots, childrenOf, orphans } = groupSessions(sorted);
  /** 树形展开集合（localStorage 持久，模块级单例外的页面层也可共享） */
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadExpanded(typeof localStorage !== "undefined" ? localStorage : null),
  );
  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpanded(typeof localStorage !== "undefined" ? localStorage : null, next);
      return next;
    });
  };
  const [subOpen, setSubOpen] = useState(false);

  return (
    <>
      <VirtualList
        items={roots}
        itemHeight={mainHeight}
        getItemHeight={(s) => {
          const kids = childrenOf.get(s.id);
          return mainHeight + (expanded.has(s.id) && kids ? kids.length * childHeight : 0);
        }}
        getKey={(s) => s.id}
        className="session-list-scroll"
        innerClassName="session-list"
        role="list"
        viewportHeight={viewportHeight}
        scrollRef={scrollRef}
        initialScrollTop={initialScrollTop}
        onScrollTop={onScrollTop}
        renderItem={(s, index) => {
          const kids = childrenOf.get(s.id);
          const open = expanded.has(s.id) && kids !== undefined && kids.length > 0;
          return (
            <div className={cn("session-tree-item", open && "open")}>
              <SessionRow
                session={s}
                index={index}
                isNew={newIds.has(s.id)}
                now={now}
                runningSince={runningSince}
                onSelect={onSelect}
              />
              {kids !== undefined && kids.length > 0 && (
                <button
                  type="button"
                  className="session-expand"
                  aria-expanded={open}
                  aria-label={`${open ? "收起" : "展开"} ${kids.length} 个子代理`}
                  onClick={() => toggleExpand(s.id)}
                >
                  <span className="session-expand-count">🤖 {kids.length}</span>
                  <span className="session-expand-caret" aria-hidden>
                    {open ? "▴" : "▾"}
                  </span>
                </button>
              )}
              {open &&
                kids!.map((c, i) => (
                  <SessionRow
                    key={c.id}
                    session={c}
                    index={i}
                    isNew={newIds.has(c.id)}
                    now={now}
                    runningSince={runningSince}
                    onSelect={onSelect}
                  />
                ))}
            </div>
          );
        }}
      />
      {orphans.length > 0 && (
        <div className="subagent-group">
          <button
            type="button"
            className="subagent-toggle"
            aria-expanded={subOpen}
            onClick={() => setSubOpen((v) => !v)}
          >
            <span>🤖 子代理 ({orphans.length})</span>
            <span className="subagent-caret">{subOpen ? "收起 ▴" : "展开 ▾"}</span>
          </button>
          {subOpen && (
            <div className="session-list subagent-list" role="list">
              {orphans.map((s, index) => (
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
