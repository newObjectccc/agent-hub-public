import { useRef, useState, type ReactNode } from "react";

export interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  refreshing?: boolean;
  children: ReactNode;
  thresholdPx?: number;
  /** 内容容器附加 class（如 chat 消息流的 flex/gap 布局） */
  contentClassName?: string;
  /** 指示文案（chat 页可换成"加载更早消息"） */
  idleLabel?: string;
  readyLabel?: string;
  busyLabel?: string;
}

/**
 * 下拉刷新：容器在顶部时继续下拉触发（touch 手势，移动优先）。
 * 桌面端请用页面上的刷新按钮作为替代路径。
 *
 * 到顶判定覆盖整页滚动区：
 * - 祖先滚动容器（window / .chat-messages 等）
 * - 后代滚动容器（虚拟列表内滚区，带 data-ptr-scroll 标记）
 */
export function PullToRefresh({
  onRefresh,
  refreshing,
  children,
  thresholdPx = 72,
  contentClassName,
  idleLabel = "下拉刷新",
  readyLabel = "松开刷新",
  busyLabel = "刷新中…",
}: PullToRefreshProps) {
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const isAtTop = () => {
    const el = containerRef.current;
    // 后代滚动容器（如会话虚拟列表）也必须到顶，手势才生效
    if (el) {
      for (const node of Array.from(el.querySelectorAll<HTMLElement>("[data-ptr-scroll]"))) {
        if (node.scrollTop > 0) return false;
      }
    }
    // 外层滚动容器（window / .chat-messages 等）：取祖先里的可滚动者
    let node: HTMLElement | null = el?.parentElement ?? null;
    while (node) {
      if (node.scrollHeight > node.clientHeight && node.scrollTop > 0) return false;
      node = node.parentElement;
    }
    return (window.scrollY ?? 0) <= 0;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (refreshing) return;
    if (e.touches.length === 1 && isAtTop()) {
      startY.current = e.touches[0].clientY;
      setDragging(true);
    }
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
    setDragging(false);
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
      <div
        className={`ptr-indicator${dragging ? " dragging" : ""}`}
        style={{ height: pull, opacity: refreshing ? 1 : pull / thresholdPx }}
      >
        <span className="ptr-pill">{refreshing ? busyLabel : pull >= thresholdPx ? readyLabel : idleLabel}</span>
      </div>
      <div
        className={contentClassName ? `ptr-content ${contentClassName}` : "ptr-content"}
        style={{ transform: refreshing ? undefined : `translateY(${pull}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
