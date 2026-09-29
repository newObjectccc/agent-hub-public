import { useState, type MutableRefObject } from "react";
import type { SessionSummary } from "../api/types";
import { useFirstSeen } from "../hooks/useFirstSeen";
import { sessionTitle, shortPath } from "../utils/display";
import { relativeTime } from "../utils/relativeTime";
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
}

/**
 * 排序（与契约一致）：主会话整体排前（子代理不抢占主会话优先级），
 * 同组内按 updatedAt 倒序；非法时间排最后，同时间用 id 升序确定性
 * tiebreaker：无论输入顺序，输出顺序唯一，刷新绝不重排（AC3-a）。
 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.slice().sort((a, b) => {
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

/** 子代理会话命名/派生特征命中（server 已下发 isSubAgent，这里容错旧 server） */
function isSubAgent(s: SessionSummary): boolean {
  return s.isSubAgent === true;
}

interface SessionRowProps {
  session: SessionSummary;
  index: number;
  isNew: boolean;
  now?: number;
  onSelect: (session: SessionSummary) => void;
}

/** 会话行（虚拟列表与子代理分组共用同一渲染，固定行高 150px） */
function SessionRow({ session: s, index, isNew, now, onSelect }: SessionRowProps) {
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
          {isSubAgent(s) && (
            <span className="badge subagent" title="pi-subagents 派生的子代理会话">
              🤖 子代理
            </span>
          )}
          <SourceBadge source={s.source} />
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
    </div>
  );
}

/**
 * 会话列表：标题（name>文件夹名）、缩写路径、来源徽章、git 状态、状态徽章、摘要、相对时间。
 * 虚拟滚动（固定行高窗口化）× 动画克制（进场只播首次插入，key 稳定 s.id）。
 * 子代理会话（isSubAgent）不与主会话混排：主会话在虚拟列表内，
 * 子代理收进列表下方“🤖 子代理 (N)”折叠分组（默认收起，展开才渲染）。
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
}: SessionListProps) {
  const sorted = sortSessions(sessions);
  const mainSessions = sorted.filter((s) => !isSubAgent(s));
  const subSessions = sorted.filter(isSubAgent);
  const [subOpen, setSubOpen] = useState(false);
  const newIds = useFirstSeen(sorted.map((s) => s.id), seenIds);
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
            onClick={() => setSubOpen((open) => !open)}
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
