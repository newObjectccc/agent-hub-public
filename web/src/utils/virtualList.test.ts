import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "./virtualList";

describe("computeVirtualWindow（虚拟列表窗口计算）", () => {
  it("300 条会话只渲染视口附近若干行（几百会话流畅的关键）", () => {
    const win = computeVirtualWindow({
      count: 300,
      itemHeight: 150,
      scrollTop: 0,
      viewportHeight: 700,
      overscan: 4,
    });
    expect(win.start).toBe(0);
    // 视口 700px ≈ 5 行 + 上下 overscan
    expect(win.end - win.start).toBeLessThanOrEqual(12);
    expect(win.end).toBeLessThan(300);
    expect(win.paddingTop).toBe(0);
    expect(win.paddingBottom).toBe((300 - win.end) * 150);
  });

  it("滚动到中段：窗口平移，总高度由上下占位撑起", () => {
    const win = computeVirtualWindow({
      count: 300,
      itemHeight: 150,
      scrollTop: 150 * 100,
      viewportHeight: 700,
      overscan: 2,
    });
    expect(win.start).toBe(98);
    expect(win.end).toBe(107);
    expect(win.paddingTop).toBe(98 * 150);
    expect(win.paddingBottom).toBe((300 - 107) * 150);
    // 占位 + 渲染高度 = 全量高度（滚动条稳定，不抖动）
    expect(win.paddingTop + (win.end - win.start) * 150 + win.paddingBottom).toBe(300 * 150);
  });

  it("滚到底部：end 封顶 count", () => {
    const win = computeVirtualWindow({
      count: 300,
      itemHeight: 150,
      scrollTop: 150 * 299,
      viewportHeight: 700,
      overscan: 4,
    });
    expect(win.end).toBe(300);
    expect(win.paddingBottom).toBe(0);
    expect(win.start).toBeGreaterThan(280);
  });

  it("视口/行高不可测量时保守全量渲染（jsdom 等）", () => {
    expect(computeVirtualWindow({ count: 100, itemHeight: 150, scrollTop: 0, viewportHeight: 0 })).toEqual({
      start: 0,
      end: 100,
      paddingTop: 0,
      paddingBottom: 0,
    });
    expect(computeVirtualWindow({ count: 100, itemHeight: 0, scrollTop: 0, viewportHeight: 600 }).end).toBe(100);
  });

  it("边界：空列表 / 负 scrollTop", () => {
    expect(computeVirtualWindow({ count: 0, itemHeight: 150, scrollTop: 0, viewportHeight: 600 })).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
    const win = computeVirtualWindow({ count: 10, itemHeight: 100, scrollTop: -50, viewportHeight: 300, overscan: 0 });
    expect(win.start).toBe(0);
  });
});
