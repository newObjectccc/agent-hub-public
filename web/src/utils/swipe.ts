/**
 * 滑动关闭判定（纯函数）：顶部提示（横幅/toast）横向滑动 dismiss 的统一口径。
 * - 只认横向主导的位移（|dx| ≥ 阈值且 > |dy|）：纵向拖动留给页面滚动 / PullToRefresh
 * - 阈值 64px：高于点按抖动容差，又不用"甩很远"（AppShell 抽屉右滑同量级）
 * - 手势是功能性操作（非动画），reduced-motion 用户体验一致
 */

export interface TouchPointLike {
  clientX: number;
  clientY: number;
}

/** 横向滑动关闭阈值（px） */
export const SWIPE_DISMISS_PX = 64;

/** 起终点 → 是否算「滑动关闭」（纯函数，touchend 判定） */
export function isSwipeDismiss(
  start: TouchPointLike,
  end: TouchPointLike,
  thresholdPx: number = SWIPE_DISMISS_PX,
): boolean {
  const dx = Math.abs(end.clientX - start.clientX);
  const dy = Math.abs(end.clientY - start.clientY);
  return dx >= thresholdPx && dx > dy;
}
