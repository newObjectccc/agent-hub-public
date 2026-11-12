/**
 * 尾随 click 吞噬（utils/trailingClick.ts）：
 * 长按弹菜单 / 点空白关菜单 / 选词手势收尾后内核补发的误触 click 要吞一击；
 * 新 pointerdown 解除武装（新手势不吞）；吞一击后自动解除（后续 click 正常）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { armTrailingClick, isTrailingClickArmed } from "./trailingClick";

function click(): MouseEvent {
  return new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }); // detail≥1 模拟真实指针 click（detail=0 是键盘合成，不吞）
}

/** jsdom 无 PointerEvent 构造器：MouseEvent + "pointerdown" type 等效派发（监听按 type 匹配） */
function pointerDown(): MouseEvent {
  return new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
}

afterEach(() => {
  // 兜底解除武装（防跨用例状态泄漏）
  document.dispatchEvent(pointerDown());
});

describe("armTrailingClick", () => {
  it("武装后下一记 click 被吞（preventDefault + 不再冒泡）", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const targetClick = vi.fn();
    target.addEventListener("click", targetClick);
    const docClick = vi.fn();
    document.addEventListener("click", docClick);

    armTrailingClick();
    expect(isTrailingClickArmed()).toBe(true);

    const e = click();
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(targetClick).not.toHaveBeenCalled(); // stopPropagation：目标处理器也没收到
    expect(docClick).not.toHaveBeenCalled();
    expect(isTrailingClickArmed()).toBe(false); // 吞一击后自动解除

    // 第二记 click 正常放行
    const e2 = click();
    target.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(false);
    expect(targetClick).toHaveBeenCalledTimes(1);

    document.removeEventListener("click", docClick);
    target.remove();
  });

  it("武装后先来了新 pointerdown（新手势）：click 不吞", () => {
    const e = click();
    armTrailingClick();
    document.dispatchEvent(pointerDown());
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(isTrailingClickArmed()).toBe(false);
  });

  it("未武装的 click 原样放行", () => {
    const e = click();
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("重复武装不叠加（单例语义：一击即止）", () => {
    armTrailingClick();
    armTrailingClick();
    const e1 = click();
    const e2 = click();
    document.dispatchEvent(e1);
    document.dispatchEvent(e2);
    expect(e1.defaultPrevented).toBe(true);
    expect(e2.defaultPrevented).toBe(false);
  });

  it("过期武装不吞（800ms 时窗外的 click 放行）", () => {
    vi.useFakeTimers();
    try {
      armTrailingClick();
      vi.advanceTimersByTime(1000);
      expect(isTrailingClickArmed()).toBe(false); // 时窗外判未武装
      const e = click();
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false); // 残余武装不误吞晚到的无关 click
    } finally {
      vi.useRealTimers();
    }
  });
});
