/**
 * 轻量虚拟滚动窗口计算（纯函数，供会话列表等高固定行列表使用）。
 *
 * 思路：固定行高 + 上下占位 padding，只渲染视口附近 [start, end) 的行，
 * 几百条会话时 DOM 节点数恒定，滚动不卡。视口高度无法测量（如 jsdom）时
 * 保守全量渲染，不影响现有行为。
 */

export interface VirtualWindowInput {
  /** 总条数 */
  count: number;
  /** 固定行高（px，含行间距） */
  itemHeight: number;
  /** 滚动容器 scrollTop */
  scrollTop: number;
  /** 滚动容器可视高度（px）；<=0 视为不可测量 → 全量渲染 */
  viewportHeight: number;
  /** 视口外多渲染的行数（上下各） */
  overscan?: number;
}

export interface VirtualWindow {
  /** 渲染起点（含） */
  start: number;
  /** 渲染终点（不含） */
  end: number;
  /** 上方占位高度 */
  paddingTop: number;
  /** 下方占位高度 */
  paddingBottom: number;
}

export const DEFAULT_OVERSCAN = 4;

export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { count, itemHeight, viewportHeight } = input;
  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));

  if (count <= 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  // 行高未知 / 视口不可测量：保守全量渲染（布局交给浏览器）
  if (!(itemHeight > 0) || !(viewportHeight > 0)) {
    return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 };
  }

  const scrollTop = Math.max(0, input.scrollTop);
  const firstVisible = Math.floor(scrollTop / itemHeight);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / itemHeight);

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + overscan);

  return {
    start,
    end,
    paddingTop: start * itemHeight,
    paddingBottom: Math.max(0, (count - end) * itemHeight),
  };
}

export interface VariableWindowInput {
  /** 每行高度（px，含行间距），数组长度 = 行数 */
  heights: readonly number[];
  /** 滚动容器 scrollTop */
  scrollTop: number;
  /** 滚动容器可视高度（px）；<=0 视为不可测量 → 全量渲染 */
  viewportHeight: number;
  /** 视口外多渲染的行数（上下各） */
  overscan?: number;
}

/**
 * 可变行高窗口（树形列表：主行 + 展开子行高度可变）。
 * 前缀和 + 二分定位首行，padding 取窗口外行高之和；总行数几百级，开销可忽略。
 */
export function computeVariableWindow(input: VariableWindowInput): VirtualWindow {
  const { heights, viewportHeight } = input;
  const count = heights.length;
  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));
  if (count <= 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  // 行高非法 / 视口不可测量：保守全量渲染（布局交给浏览器）
  if (heights.some((h) => !(h > 0)) || !(viewportHeight > 0)) {
    return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 };
  }

  // 前缀和：prefix[i] = 前 i 行总高
  const prefix = new Array<number>(count + 1);
  prefix[0] = 0;
  for (let i = 0; i < count; i += 1) prefix[i + 1] = prefix[i] + heights[i];

  const scrollTop = Math.max(0, input.scrollTop);
  const bottom = scrollTop + viewportHeight;

  // 二分：第一个 prefix[end] > scrollTop 的 end 即首个（部分）可见行
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const firstVisible = lo;

  // 末个可见行：prefix[i] < bottom 的最大 i
  let lo2 = firstVisible;
  let hi2 = count - 1;
  let lastVisible = firstVisible;
  while (lo2 <= hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (prefix[mid] < bottom) {
      lastVisible = mid;
      lo2 = mid + 1;
    } else {
      hi2 = mid - 1;
    }
  }

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + 1 + overscan);
  return {
    start,
    end,
    paddingTop: prefix[start],
    paddingBottom: Math.max(0, prefix[count] - prefix[end]),
  };
}
