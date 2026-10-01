/**
 * 动效偏好（UX 审查 AC6）：JS 平滑滚动尊重 prefers-reduced-motion。
 */
import { describe, expect, it } from "vitest";
import { prefersReducedMotion, scrollBehaviorOf } from "./motion";

describe("prefers-reduced-motion → 滚动 behavior", () => {
  it("系统开启减少动态 → behavior auto（瞬时滚动）", () => {
    const win = { matchMedia: () => ({ matches: true }) };
    expect(prefersReducedMotion(win)).toBe(true);
    expect(scrollBehaviorOf(win)).toBe("auto");
  });

  it("未开启 → behavior smooth（保持现有平滑体验）", () => {
    const win = { matchMedia: () => ({ matches: false }) };
    expect(prefersReducedMotion(win)).toBe(false);
    expect(scrollBehaviorOf(win)).toBe("smooth");
  });

  it("matchMedia 不可用/异常 → 保守按 auto（不做强动画）", () => {
    expect(prefersReducedMotion(null)).toBe(true);
    expect(prefersReducedMotion({})).toBe(true);
    const throwing = {
      matchMedia: () => {
        throw new Error("boom");
      },
    };
    expect(scrollBehaviorOf(throwing)).toBe("auto");
  });
});
