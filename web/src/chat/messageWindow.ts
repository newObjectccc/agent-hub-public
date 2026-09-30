/**
 * 长会话消息窗口化（尾部锚定）：
 * - 只裁剪顶部（最早）消息，尾部（流式）消息恒完整渲染（锚定底部）
 * - 高度实测后才启用：被裁掉的行高与真实一致，切换窗口滚动位置不跳动
 * - 短会话 / 有未测量行 / 视口高度不可测（jsdom）→ 保守全量渲染，行为不变
 *
 * 高度口径：`.chat-stream` 是 flex column + gap，行高需含行间距（见 MESSAGE_GAP_PX）。
 * 占位 div 与首行之间还有一个 flex gap，因此 paddingTop 要扣掉一个 gap。
 */
import { computeVariableWindow } from "../utils/virtualList";

/** .chat-stream 的 flex gap（与 styles.css `gap: 11px` 保持一致） */
export const MESSAGE_GAP_PX = 11;

export interface MessageWindowInput {
  /** 消息总数 */
  count: number;
  /** 每条消息实测高度（不含 gap）；未测量为 0 */
  heights: readonly number[];
  /** 全部行都已实测 */
  allMeasured: boolean;
  /** 相对消息列表顶部的滚动偏移（容器 scrollTop - 列表在内容中的偏移） */
  scrollTop: number;
  /** 滚动容器可视高度（px）；<=0 视为不可测量 → 全量渲染 */
  viewportHeight: number;
  /** 少于该条数不启用窗口化（短会话零开销） */
  minCount: number;
  /** 视口外上下多渲染的行数 */
  overscan?: number;
}

export interface MessageWindow {
  /** 是否启用窗口化（false 时 start 恒 0、全量渲染） */
  virtualized: boolean;
  /** 渲染起点（含）；终点恒为 count（尾部完整渲染） */
  start: number;
  /** 顶部占位高度（px） */
  paddingTop: number;
}

export function computeMessageWindow(input: MessageWindowInput): MessageWindow {
  const full: MessageWindow = { virtualized: false, start: 0, paddingTop: 0 };
  const { count, heights, allMeasured, minCount } = input;
  if (count < minCount) return full;
  if (!allMeasured || heights.length !== count) return full;
  if (!(input.viewportHeight > 0)) return full;

  const withGap = new Array<number>(count);
  for (let i = 0; i < count; i += 1) withGap[i] = heights[i] + MESSAGE_GAP_PX;

  const win = computeVariableWindow({
    heights: withGap,
    scrollTop: Math.max(0, input.scrollTop),
    viewportHeight: input.viewportHeight,
    overscan: input.overscan,
  });
  // 尾部恒渲染：起点取窗口起点，终点强制 count
  const start = Math.max(0, Math.min(win.start, count));
  // 占位高 = 裁掉行的高（含行间距）- 占位与首行之间的一个 flex gap
  const paddingTop = start > 0 ? Math.max(0, win.paddingTop - MESSAGE_GAP_PX) : 0;
  return { virtualized: true, start, paddingTop };
}

/**
 * 占位高度（px）：裁掉 [0, start) 行的实测高度之和（含行间距）再扣一个 flex gap。
 * 窗口收缩限速时按渐进后的 start 重算，保证与实际渲染内容一致。
 */
export function paddingTopFor(heights: readonly number[], start: number): number {
  if (start <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(start, heights.length); i += 1) sum += heights[i] + MESSAGE_GAP_PX;
  return Math.max(0, sum - MESSAGE_GAP_PX);
}

/**
 * 清理已卸载行的元素引用（ref 回调传 null 时拿不到 id，窗口裁剪/消息替换会留下 detached 条目）：
 * 只清元素与观察，不碰行高缓存（paddingTop 与重新挂载复测都要用）。
 * 返回被清理的条目，供调用方 unobserve。
 */
export function pruneDetachedRowEls(els: Map<string, HTMLElement>): Array<{ id: string; el: HTMLElement }> {
  const removed: Array<{ id: string; el: HTMLElement }> = [];
  for (const [id, el] of els) {
    if (!el.isConnected) {
      els.delete(id);
      removed.push({ id, el });
    }
  }
  return removed;
}

/**
 * 高度守恒（滚动不跳的关键）：
 * 全量总高 = Σh + (n-1)·g；窗口总高 = paddingTop + g + Σh[start..] + (n-start-1)·g
 * 代入 paddingTop = Σh[..start] + start·g - g 得两式相等。
 */
export function fullHeight(heights: readonly number[]): number {
  let sum = 0;
  for (const h of heights) sum += h;
  return sum + Math.max(0, heights.length - 1) * MESSAGE_GAP_PX;
}

export function windowedHeight(window: MessageWindow, heights: readonly number[]): number {
  // start=0 不渲染占位 div，布局与全量一致
  if (!window.virtualized || window.start === 0) return fullHeight(heights);
  const tailRows = heights.length - window.start;
  // 尾部 0 行：只有占位 div，无与首行的 gap
  if (tailRows <= 0) return window.paddingTop;
  let tail = 0;
  for (let i = window.start; i < heights.length; i += 1) tail += heights[i];
  return window.paddingTop + MESSAGE_GAP_PX + tail + (tailRows - 1) * MESSAGE_GAP_PX;
}
