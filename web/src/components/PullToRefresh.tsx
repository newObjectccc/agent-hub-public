import { useEffect, useRef, useState, type ReactNode } from "react";

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

/** 手势判定阈值（px）：纵向位移超过它才认定为"下拉刷新"手势 */
const PULL_START_PX = 6;

/**
 * 下拉刷新：容器在顶部时继续下拉触发（touch 手势，移动优先）。
 * 桌面端请用页面上的刷新按钮作为替代路径。
 *
 * 手势纪律（滚动手感专项）：
 * - 上滑/微动零 re-render：未判定为下拉前不 setState，浏览器原生滚动零干扰；
 * - 判定阈值 6px 位移后才接管为下拉模式（避免与列表拖动滚动抢手势）；
 * - 拖动量 rAF 节流（每帧最多一次 setState），避免 touchmove 风暴拖慢滚动；
 * - 全程不 preventDefault：滚动永远交给浏览器，下拉只在列表到顶时才有位移。
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
  /** 手势是否已判定为"下拉"（超过位移阈值且在顶部） */
  const pullingRef = useRef(false);
  /** 最新拖动量（rAF 节流用，避免 setState 风暴） */
  const pendingPull = useRef(0);
  const rafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 组件卸载清掉未落盘的 rAF
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

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
      pullingRef.current = false;
      pendingPull.current = 0;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current == null || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (!pullingRef.current) {
      // 未判定：上滑/微动直接放行（零 re-render，滚动手感归浏览器）
      if (dy > PULL_START_PX) {
        pullingRef.current = true;
        setDragging(true);
      } else {
        return;
      }
    }
    const next = dy > 0 ? Math.min(dy * 0.5, thresholdPx * 1.4) : 0;
    if (next === pendingPull.current) return;
    pendingPull.current = next;
    // rAF 节流：每帧最多一次 setState
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setPull(pendingPull.current);
      });
    }
  };

  const onTouchEnd = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // 触发判定用最新拖动量（state 可能滞后一帧）
    if (startY.current != null && pullingRef.current && pendingPull.current >= thresholdPx) {
      void onRefresh();
    }
    startY.current = null;
    pullingRef.current = false;
    pendingPull.current = 0;
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
        style={{ transform: refreshing ? undefined : pull > 0 ? `translateY(${pull}px)` : undefined }}
      >
        {children}
      </div>
    </div>
  );
}
