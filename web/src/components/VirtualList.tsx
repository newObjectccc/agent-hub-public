import { Fragment, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import { computeVariableWindow, computeVirtualWindow } from "../utils/virtualList";

export interface VirtualListProps<T> {
  items: T[];
  /** 固定行高（px，含行间距），必须与 CSS 实际行高一致 */
  itemHeight: number;
  /** 可变行高（树形展开时行高可变）；提供后 itemHeight 仅作缺省值 */
  getItemHeight?: (item: T, index: number) => number;
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** 滚动容器 class */
  className?: string;
  /** 内容容器 class */
  innerClassName?: string;
  /** 内容容器 role（如 list） */
  role?: string;
  /** 注入视口高度（测试/特殊布局）；缺省取滚动容器 clientHeight */
  viewportHeight?: number;
  overscan?: number;
  /** 暴露滚动容器（滚动位置记忆等） */
  scrollRef?: MutableRefObject<HTMLDivElement | null>;
  /** 首挂载恢复的滚动位置（列表 scrollTop 记忆） */
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
}

/**
 * 轻量虚拟滚动列表：固定行高 + 上下占位 padding，只渲染视口附近若干行。
 * 视口高度不可测量（如 jsdom）时保守全量渲染，不影响小列表行为。
 */
export function VirtualList<T>({
  items,
  itemHeight,
  getItemHeight,
  getKey,
  renderItem,
  className,
  innerClassName,
  role,
  viewportHeight,
  overscan,
  scrollRef,
  initialScrollTop,
  onScrollTop,
}: VirtualListProps<T>) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const restoredRef = useRef(false);

  const setRefs = (el: HTMLDivElement | null) => {
    localRef.current = el;
    if (scrollRef) scrollRef.current = el;
  };

  // 测量视口高度（挂载 + 窗口尺寸变化）
  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    const measure = () => setMeasuredHeight(el.clientHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // 列表 scrollTop 记忆：数据就绪后恢复一次（items 未到时内容高度不足，恢复会被 clamp）
  useEffect(() => {
    const el = localRef.current;
    if (!el || restoredRef.current || items.length === 0) return;
    restoredRef.current = true;
    if (initialScrollTop && initialScrollTop > 0) {
      el.scrollTop = initialScrollTop;
      // 同步窗口计算基准（浏览器会 clamp，读回实际值）
      setScrollTop(el.scrollTop);
      // Chrome scroll anchoring / 窗口渲染重组可能挤动 scrollTop，帧末校正一次
      requestAnimationFrame(() => {
        if (Math.abs(el.scrollTop - initialScrollTop) > 40) {
          el.scrollTop = initialScrollTop;
          setScrollTop(el.scrollTop);
        }
      });
    }
  }, [items.length, initialScrollTop]);

  const win = getItemHeight
    ? computeVariableWindow({
        heights: items.map((item, i) => getItemHeight(item, i)),
        scrollTop,
        viewportHeight: viewportHeight ?? measuredHeight,
        overscan,
      })
    : computeVirtualWindow({
        count: items.length,
        itemHeight,
        scrollTop,
        viewportHeight: viewportHeight ?? measuredHeight,
        overscan,
      });

  return (
    <div
      className={className ? `virtual-scroll ${className}` : "virtual-scroll"}
      ref={setRefs}
      data-ptr-scroll=""
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setScrollTop(top);
        onScrollTop?.(top);
      }}
    >
      <div
        className={innerClassName}
        role={role}
        style={{ paddingTop: win.paddingTop, paddingBottom: win.paddingBottom }}
      >
        {items.slice(win.start, win.end).map((item, i) => (
          <Fragment key={getKey(item, win.start + i)}>{renderItem(item, win.start + i)}</Fragment>
        ))}
      </div>
    </div>
  );
}
