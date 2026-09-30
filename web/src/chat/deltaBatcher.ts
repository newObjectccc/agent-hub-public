/**
 * 流式 delta 批处理器（WS 风暴批处理）：
 * text_delta / thinking_delta 高频事件（可达 50+/秒）逐条 setState 会让 React
 * 每条都渲染一次。这里按时间窗（默认 40ms，33-50ms 区间）把连续 delta 合并成
 * 一批，只做一次 setMessages / 一次渲染，打字机观感无损（每批推进多个字符）。
 *
 * 顺序语义不变：非 delta 事件（message_start / message_end / tool_*）到达前，
 * 调用方必须先 flushNow()，保证在途 delta 先落进消息列表（message_end 的
 * 占位合并去重依赖占位文本已完整，见 messageStream.findTailPlaceholder）。
 */
import type { WsEvent } from "./messageStream";

/** 默认合并窗口（ms）：打字机延迟无感（<100ms），渲染次数大幅下降 */
export const DEFAULT_BATCH_WINDOW_MS = 40;

/**
 * 批处理配置（测试钩子）：
 * - windowMs = 0 → push 即同步 flush（等价改造前逐条 setState，用于 before/after 基准对比）
 */
export const streamBatchConfig = {
  windowMs: DEFAULT_BATCH_WINDOW_MS,
};

/** 把相邻同 messageId+同类型 delta 合并为一个事件（减少 reduce 中间数组） */
export function mergeDeltaEvents(events: WsEvent[]): WsEvent[] {
  const out: WsEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (
      last &&
      last.type === ev.type &&
      last.messageId === ev.messageId &&
      typeof last.delta === "string" &&
      typeof ev.delta === "string"
    ) {
      out[out.length - 1] = { ...last, delta: last.delta + ev.delta };
    } else {
      out.push(ev);
    }
  }
  return out;
}

export class DeltaBatcher {
  private queue: WsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;

  constructor(
    private readonly onFlush: (events: WsEvent[]) => void,
    windowMs: number = streamBatchConfig.windowMs,
  ) {
    this.windowMs = windowMs;
  }

  /** 缓冲一条 delta；到窗即合并 flush（windowMs<=0 时同步逐条 flush） */
  push(event: WsEvent): void {
    this.queue.push(event);
    if (this.windowMs <= 0) {
      this.flushNow();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.windowMs);
  }

  /** 立即把缓冲的 delta 落盘（非 delta 事件前必须调用，保序） */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const events = mergeDeltaEvents(this.queue);
    this.queue = [];
    this.onFlush(events);
  }

  /** 卸载：丢弃定时器与缓冲（不再回调） */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }

  /** 当前缓冲中的事件数（测试/诊断用） */
  get pending(): number {
    return this.queue.length;
  }
}
