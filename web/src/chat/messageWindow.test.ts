/**
 * 长会话窗口化计算回归：
 * 1. 尾部恒渲染（end=count，流式尾部完整）
 * 2. 高度守恒：窗口化前后内容总高一致（滚动不跳）
 * 3. 短会话 / 未测量 / 视口不可测 → 保守全量渲染（行为零变化兜底）
 * 4. 视口附近 [start, end) 才渲染，顶部裁剪 + 占位高度
 */
import { describe, expect, it } from "vitest";
import { computeMessageWindow, fullHeight, windowedHeight, paddingTopFor, MESSAGE_GAP_PX } from "./messageWindow";

function heights(count: number, h = 80): number[] {
  return new Array(count).fill(h);
}

describe("computeMessageWindow 尾部锚定窗口化", () => {
  it("短会话不启用窗口化（零开销）", () => {
    const win = computeMessageWindow({
      count: 20,
      heights: heights(20),
      allMeasured: true,
      scrollTop: 0,
      viewportHeight: 600,
      minCount: 80,
    });
    expect(win).toEqual({ virtualized: false, start: 0, paddingTop: 0 });
  });

  it("有未测量行 → 保守全量渲染（高度未知不裁剪）", () => {
    const hs = heights(100);
    hs[10] = 0;
    const win = computeMessageWindow({
      count: 100,
      heights: hs,
      allMeasured: false,
      scrollTop: 0,
      viewportHeight: 600,
      minCount: 80,
    });
    expect(win.virtualized).toBe(false);
    expect(win.start).toBe(0);
  });

  it("视口高度不可测（jsdom）→ 全量渲染", () => {
    const win = computeMessageWindow({
      count: 100,
      heights: heights(100),
      allMeasured: true,
      scrollTop: 0,
      viewportHeight: 0,
      minCount: 80,
    });
    expect(win.virtualized).toBe(false);
  });

  it("底部视口：只裁顶部，尾部消息完整渲染", () => {
    const hs = heights(200, 80); // 含 gap 后每行 91px
    const win = computeMessageWindow({
      count: 200,
      heights: hs,
      allMeasured: true,
      scrollTop: fullHeight(hs) - 600,
      viewportHeight: 600,
      minCount: 80,
      overscan: 4,
    });
    expect(win.virtualized).toBe(true);
    expect(win.start).toBeGreaterThan(0);
    expect(win.start).toBeLessThan(200 - Math.ceil(600 / 91)); // 起点在可视区之上
    expect(win.paddingTop).toBeGreaterThan(0);
  });

  it("顶部视口：不裁剪（start=0、无占位）", () => {
    const hs = heights(200, 80);
    const win = computeMessageWindow({
      count: 200,
      heights: hs,
      allMeasured: true,
      scrollTop: 0,
      viewportHeight: 600,
      minCount: 80,
    });
    expect(win.start).toBe(0);
    expect(win.paddingTop).toBe(0);
  });

  it("高度守恒：窗口化前后内容总高一致（切换窗口滚动不跳）", () => {
    const hs = [80, 120, 40, 200, 90, 60, 150, 75, 88, 102, 64, 91].flatMap((h) => heights(12, h));
    for (const scrollTop of [0, 500, 1200, 3000, fullHeight(hs) - 600]) {
      const win = computeMessageWindow({
        count: hs.length,
        heights: hs,
        allMeasured: true,
        scrollTop,
        viewportHeight: 600,
        minCount: 80,
        overscan: 4,
      });
      expect(windowedHeight(win, hs)).toBe(fullHeight(hs));
    }
  });

  it("占位高度 = 裁掉行高（含行间距）- 一个 flex gap", () => {
    const hs = heights(200, 80);
    const win = computeMessageWindow({
      count: 200,
      heights: hs,
      allMeasured: true,
      scrollTop: 5000,
      viewportHeight: 600,
      minCount: 80,
      overscan: 0,
    });
    expect(win.paddingTop).toBe(win.start * (80 + MESSAGE_GAP_PX) - MESSAGE_GAP_PX);
  });

  it("paddingTopFor：渐进限速后按 start 重算占位，与窗口化总高守恒", () => {
    const hs = heights(200, 80);
    for (const start of [1, 10, 24, 100, 200]) {
      const pad = paddingTopFor(hs, start);
      expect(pad).toBe(start * (80 + MESSAGE_GAP_PX) - MESSAGE_GAP_PX);
      // 限速后的窗口（start 渐进）总高仍等于全量总高（滚动不跳）
      const win = { virtualized: true, start, paddingTop: pad };
      expect(windowedHeight(win, hs)).toBe(fullHeight(hs));
    }
    expect(paddingTopFor(hs, 0)).toBe(0);
  });
});
