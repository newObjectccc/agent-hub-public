import { describe, expect, it } from "vitest";
import { computeVariableWindow, computeVirtualWindow } from "./virtualList";

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

describe("computeVariableWindow（树形可变行高窗口）", () => {
  it("行高不等：窗口按前缀和定位，padding 为窗口外行高之和", () => {
    // 5 行：高度 [100, 200, 100, 200, 100]，总 700
    const heights = [100, 200, 100, 200, 100];
    const win = computeVariableWindow({ heights, scrollTop: 150, viewportHeight: 250, overscan: 0 });
    // 视口 [150, 400)：第 1 行(100-300)、第 2 行(300-400)、第 3 行起点 400 不含
    expect(win.start).toBe(1);
    expect(win.end).toBe(3);
    expect(win.paddingTop).toBe(100);
    expect(win.paddingBottom).toBe(300);
  });

  it("展开行高变大（主行+子行）后窗口随之平移，占位高度总量守恒", () => {
    const collapsed = [128, 128, 128];
    const expanded = [128 + 2 * 76, 128, 128];
    const a = computeVariableWindow({ heights: collapsed, scrollTop: 0, viewportHeight: 200, overscan: 0 });
    const b = computeVariableWindow({ heights: expanded, scrollTop: 0, viewportHeight: 200, overscan: 0 });
    expect(a.end).toBeGreaterThan(b.end); // 行高变大后同屏渲染行数变少
    const rendered = (hs: number[], w: { start: number; end: number }) =>
      hs.slice(w.start, w.end).reduce((s, h) => s + h, 0);
    expect(a.paddingTop + rendered(collapsed, a) + a.paddingBottom).toBe(384);
    expect(b.paddingTop + rendered(expanded, b) + b.paddingBottom).toBe(536);
  });

  it("视口不可测量 / 行高非法：保守全量渲染", () => {
    expect(computeVariableWindow({ heights: [100, 200], scrollTop: 0, viewportHeight: 0 }).end).toBe(2);
    expect(computeVariableWindow({ heights: [100, 0], scrollTop: 0, viewportHeight: 600 }).end).toBe(2);
    expect(computeVariableWindow({ heights: [], scrollTop: 0, viewportHeight: 600 }).end).toBe(0);
  });
});
