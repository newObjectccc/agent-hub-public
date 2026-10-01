/**
 * 动效偏好（prefers-reduced-motion）：JS 平滑滚动尊重系统"减少动态效果"。
 * 纯函数可测：只读 matchMedia，不直接碰 DOM 滚动。
 */

export interface MediaQueryLike {
  matches: boolean;
}

export interface WindowLike {
  matchMedia?: (query: string) => MediaQueryLike;
}

/** 用户是否开启"减少动态效果"（matchMedia 不可用 → 保守视为开启，不用平滑滚动） */
export function prefersReducedMotion(win: WindowLike | null | undefined): boolean {
  try {
    if (!win || typeof win.matchMedia !== "function") return true;
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return true;
  }
}

/** JS 滚动 behavior：尊重系统动效偏好（减少动态 → "auto" 瞬时滚动） */
export function scrollBehaviorOf(win: WindowLike | null | undefined): ScrollBehavior {
  return prefersReducedMotion(win) ? "auto" : "smooth";
}
