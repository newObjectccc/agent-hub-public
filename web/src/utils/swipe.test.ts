/**
 * 滑动关闭判定（纯函数）：顶部提示横向滑动 dismiss 的口径回归。
 */
import { describe, expect, it } from "vitest";
import { isSwipeDismiss, SWIPE_DISMISS_PX } from "./swipe";

const p = (x: number, y: number) => ({ clientX: x, clientY: y });

describe("isSwipeDismiss", () => {
  it("横向位移达标（左右皆可）→ 算滑动关闭", () => {
    expect(isSwipeDismiss(p(200, 100), p(200 - SWIPE_DISMISS_PX, 102))).toBe(true);
    expect(isSwipeDismiss(p(200, 100), p(200 + SWIPE_DISMISS_PX, 98))).toBe(true);
  });

  it("位移不足阈值（点按抖动）→ 不算", () => {
    expect(isSwipeDismiss(p(200, 100), p(180, 100))).toBe(false);
  });

  it("纵向拖动（留给页面滚动/PullToRefresh）→ 不算", () => {
    expect(isSwipeDismiss(p(200, 100), p(210, 260))).toBe(false);
  });

  it("对角位移横向不占优 → 不算；自定义阈值生效", () => {
    expect(isSwipeDismiss(p(0, 0), p(80, 90))).toBe(false);
    expect(isSwipeDismiss(p(0, 0), p(30, 2), 24)).toBe(true);
    expect(isSwipeDismiss(p(0, 0), p(30, 2), 64)).toBe(false);
  });
});
