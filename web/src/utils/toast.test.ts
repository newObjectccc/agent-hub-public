/**
 * toast 防刷屏（UX 审查 AC6）：去重合并、上限 3 条、手动关闭、定时自动消失。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOAST_MAX,
  dismissToast,
  getToasts,
  showToast,
  subscribeToasts,
} from "./toast";

function clearAll(): void {
  for (const t of getToasts()) dismissToast(t.id);
}

beforeEach(() => {
  clearAll();
  vi.useFakeTimers();
});

afterEach(() => {
  clearAll();
  vi.useRealTimers();
});

describe("toast 去重/合并 + 上限", () => {
  it("同文案 toast 去重合并：不叠加条目，只刷新存活时间", () => {
    showToast("已复制");
    vi.advanceTimersByTime(1000);
    showToast("已复制");
    expect(getToasts().map((t) => t.text)).toEqual(["已复制"]);
    // 合并后重新计时：再过原时限 - 不应消失（第二次弹出后满时限才消失）
    vi.advanceTimersByTime(2000);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(getToasts()).toHaveLength(0);
  });

  it("上限 TOAST_MAX 条：超出丢最旧的，绝不无限堆叠", () => {
    showToast("一");
    showToast("二");
    showToast("三");
    showToast("四");
    showToast("五");
    const texts = getToasts().map((t) => t.text);
    expect(texts).toHaveLength(TOAST_MAX);
    expect(texts).toEqual(["三", "四", "五"]);
  });

  it("手动 dismissToast 即刻关闭（关闭按钮通道）", () => {
    showToast("手动关");
    expect(getToasts()).toHaveLength(1);
    dismissToast(getToasts()[0].id);
    expect(getToasts()).toHaveLength(0);
  });

  it("到时自动消失（TOAST_DURATION_MS）", () => {
    showToast("瞬时");
    vi.advanceTimersByTime(2400);
    expect(getToasts()).toHaveLength(0);
  });

  it("订阅者实时收到快照（去重/上限后仍是最新列表）", () => {
    const seen: string[][] = [];
    const off = subscribeToasts((items) => seen.push(items.map((t) => t.text)));
    showToast("a");
    showToast("a");
    showToast("b");
    off();
    expect(seen[seen.length - 1]).toEqual(["a", "b"]);
  });
});
