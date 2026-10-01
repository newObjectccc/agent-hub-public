/**
 * 指针命中判定（UX 审查 AC4 语音按钮）：手指移出按钮热区 = 取消（IM 惯例）。
 * 纯函数可测：pointer capture 下 pointermove/up 仍派发到按钮，用坐标判定在内/在外。
 */

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 点是否落在矩形内（含边界） */
export function isPointInRect(rect: RectLike, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** 从 DOM 元素读矩形（不可测/无布局 → null，调用方按“在内”保守处理） */
export function rectOf(el: Element | null | undefined): RectLike | null {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
