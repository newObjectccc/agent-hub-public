import { useRef, useState, type ReactNode } from "react";

export interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  refreshing?: boolean;
  children: ReactNode;
  thresholdPx?: number;
}

/**
 * 下拉刷新：容器在顶部时继续下拉触发（touch 手势，移动优先）。
 * 桌面端请用页面上的刷新按钮作为替代路径。
 */
export function PullToRefresh({ onRefresh, refreshing, children, thresholdPx = 72 }: PullToRefreshProps) {
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const isAtTop = () => {
    const el = containerRef.current;
    // 外层滚动容器是 .chat-messages / window；这里取最近的可滚动祖先
    let node: HTMLElement | null = el?.parentElement ?? null;
    while (node) {
      if (node.scrollHeight > node.clientHeight && node.scrollTop > 0) return false;
      node = node.parentElement;
    }
    return (window.scrollY ?? 0) <= 0;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (refreshing) return;
    if (e.touches.length === 1 && isAtTop()) startY.current = e.touches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current == null || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) setPull(Math.min(dy * 0.5, thresholdPx * 1.4));
  };

  const onTouchEnd = () => {
    if (startY.current != null && pull >= thresholdPx) {
      void onRefresh();
    }
    startY.current = null;
    setPull(0);
  };

  return (
    <div
      className="ptr"
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="ptr-indicator" style={{ height: pull, opacity: refreshing ? 1 : pull / thresholdPx }}>
        {refreshing ? "刷新中…" : pull >= thresholdPx ? "松开刷新" : "下拉刷新"}
      </div>
      <div style={{ transform: refreshing ? undefined : `translateY(${pull}px)` }}>{children}</div>
    </div>
  );
}
