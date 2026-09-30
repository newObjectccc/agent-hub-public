/**
 * 发送触觉反馈：navigator.vibrate，不支持/被拒绝一律静默降级。
 */

export function vibrate(ms: number): boolean {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      return navigator.vibrate(ms);
    }
  } catch {
    // 静默降级（iOS 等不支持 / 用户代理拒绝）
  }
  return false;
}
