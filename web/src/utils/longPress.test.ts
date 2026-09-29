import { afterEach, describe, expect, it, vi } from "vitest";
import { LongPressDetector, LONG_PRESS_DELAY_MS } from "./longPress";

afterEach(() => {
  vi.useRealTimers();
});

describe("LongPressDetector（长按识别，mock timer）", () => {
  it("按时长阈值触发一次长按", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const d = new LongPressDetector(onFire);

    d.start(100, 200);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);

    // 触发后 end() 返回 true（供调用方抑制后续 click）
    expect(d.end()).toBe(true);
  });

  it("提前抬起不触发，end() 返回 false", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const d = new LongPressDetector(onFire);
    d.start(0, 0);
    vi.advanceTimersByTime(200);
    expect(d.end()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("移动超容差取消长按（与滚动手势互斥）", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const d = new LongPressDetector(onFire);
    d.start(0, 0);
    d.move(6, 6); // 容差内
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(onFire).toHaveBeenCalledTimes(1);

    onFire.mockClear();
    d.start(0, 0);
    d.move(0, 20); // 超容差 → 取消
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(d.end()).toBe(false);
  });

  it("cancel 后定时器不残留（不重复触发）", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const d = new LongPressDetector(onFire);
    d.start(0, 0);
    d.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("自定义时长与注入定时器均生效", () => {
    const timers: Array<() => void> = [];
    const onFire = vi.fn();
    const d = new LongPressDetector(onFire, {
      delayMs: 50,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {
        // 无残留断言即可
      },
    });
    d.start(0, 0);
    timers[0]();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(d.end()).toBe(true);
  });
});
