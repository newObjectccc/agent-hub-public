/**
 * 指针命中判定（UX 审查 AC4 语音按钮）：pointer capture 下手指移出按钮 = 松开取消。
 */
import { describe, expect, it } from "vitest";
import { isPointInRect, rectOf } from "./pointer";

const rect = { left: 100, top: 200, right: 144, bottom: 244 };

describe("isPointInRect", () => {
  it("矩形内（含边界）→ true", () => {
    expect(isPointInRect(rect, 122, 222)).toBe(true);
    expect(isPointInRect(rect, 100, 200)).toBe(true);
    expect(isPointInRect(rect, 144, 244)).toBe(true);
  });

  it("移出按钮（任意方向）→ false", () => {
    expect(isPointInRect(rect, 99, 222)).toBe(false);
    expect(isPointInRect(rect, 122, 245)).toBe(false);
    expect(isPointInRect(rect, 0, 0)).toBe(false);
    expect(isPointInRect(rect, 300, 300)).toBe(false);
  });
});

describe("rectOf", () => {
  it("无元素/无布局（宽高为 0）→ null（调用方保守按在内处理）", () => {
    expect(rectOf(null)).toBeNull();
    expect(rectOf(document.createElement("div"))).toBeNull();
  });

  it("有布局元素 → 返回矩形", () => {
    const el = document.createElement("button");
    el.getBoundingClientRect = () => ({ ...rect, width: 44, height: 44, x: 100, y: 200, toJSON: () => ({}) });
    expect(rectOf(el)).toEqual(rect);
  });
});
