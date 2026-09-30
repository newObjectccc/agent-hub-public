/**
 * 流式 delta 批处理器回归：
 * 1. 时间窗内多条 delta 合并为一次 flush（setState 次数大降）
 * 2. 相邻同 messageId delta 合并为单事件（reduce 中间数组少）
 * 3. flushNow 保序（message_end 前在途 delta 先落盘）
 * 4. windowMs=0 = 逐条 flush（改造前行为，基准对比用）
 * 5. cancel 后不再回调
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaBatcher, mergeDeltaEvents, streamBatchConfig, DEFAULT_BATCH_WINDOW_MS } from "./deltaBatcher";
import type { WsEvent } from "./messageStream";

function delta(messageId: string, text: string): WsEvent {
  return { type: "text_delta", messageId, delta: text };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeDeltaEvents", () => {
  it("相邻同 messageId+类型 delta 合并为一个事件", () => {
    const merged = mergeDeltaEvents([delta("a", "你"), delta("a", "好"), delta("b", "！"), delta("a", "?")]);
    expect(merged).toEqual([delta("a", "你好"), delta("b", "！"), delta("a", "?")]);
  });

  it("text_delta 与 thinking_delta 不互相合并", () => {
    const merged = mergeDeltaEvents([
      delta("a", "x"),
      { type: "thinking_delta", messageId: "a", delta: "y" },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe("DeltaBatcher 时间窗批处理", () => {
  it("窗口内 N 条 delta 只 flush 一次（N:1 合并）", () => {
    const onFlush = vi.fn();
    const b = new DeltaBatcher(onFlush, 40);
    b.push(delta("a", "1"));
    b.push(delta("a", "2"));
    b.push(delta("a", "3"));
    expect(onFlush).not.toHaveBeenCalled();
    expect(b.pending).toBe(3);
    vi.advanceTimersByTime(40);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toEqual([delta("a", "123")]);
    expect(b.pending).toBe(0);
  });

  it("跨窗口的 delta 分多批 flush（打字机持续推进）", () => {
    const onFlush = vi.fn();
    const b = new DeltaBatcher(onFlush, 40);
    b.push(delta("a", "1"));
    vi.advanceTimersByTime(40);
    b.push(delta("a", "2"));
    vi.advanceTimersByTime(40);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("flushNow 立即落盘并取消定时器（非 delta 事件前保序）", () => {
    const onFlush = vi.fn();
    const b = new DeltaBatcher(onFlush, 40);
    b.push(delta("a", "1"));
    b.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("windowMs=0：逐条同步 flush（等价改造前逐条 setState）", () => {
    const onFlush = vi.fn();
    const b = new DeltaBatcher(onFlush, 0);
    b.push(delta("a", "1"));
    b.push(delta("a", "2"));
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(b.pending).toBe(0);
  });

  it("cancel 丢弃缓冲与定时器，不再回调", () => {
    const onFlush = vi.fn();
    const b = new DeltaBatcher(onFlush, 40);
    b.push(delta("a", "1"));
    b.cancel();
    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();
    expect(b.pending).toBe(0);
  });

  it("默认窗口落在 33-50ms 打字机无感区间", () => {
    expect(DEFAULT_BATCH_WINDOW_MS).toBeGreaterThanOrEqual(33);
    expect(DEFAULT_BATCH_WINDOW_MS).toBeLessThanOrEqual(50);
    expect(streamBatchConfig.windowMs).toBe(DEFAULT_BATCH_WINDOW_MS);
  });
});
