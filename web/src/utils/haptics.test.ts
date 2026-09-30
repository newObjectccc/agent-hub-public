/**
 * 发送触觉反馈：navigator.vibrate(10)，不支持/抛错静默降级。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { vibrate } from "./haptics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vibrate（发送触觉）", () => {
  it("支持时调用 navigator.vibrate(ms) 并透传返回值", () => {
    const spy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { vibrate: spy });
    expect(vibrate(10)).toBe(true);
    expect(spy).toHaveBeenCalledWith(10);
  });

  it("不支持（无 vibrate）→ false 静默降级", () => {
    vi.stubGlobal("navigator", {});
    expect(vibrate(10)).toBe(false);
  });

  it("vibrate 抛错（用户代理拒绝）→ 吞掉返回 false", () => {
    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new Error("blocked");
      },
    });
    expect(vibrate(10)).toBe(false);
  });
});
