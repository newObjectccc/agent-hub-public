/**
 * 每秒滴答一次的"现在"（驱动"已运行 X 分钟"等实时标记）。
 * 集中 ticker（UX 审查 AC6）：全部订阅者共享一个 setInterval——
 * N 张运行中的工具卡不再各自挂 1s 定时器；无订阅者即停表。
 * 仅在 active 时订阅；测试可通过组件的 now 注入绕过。
 */
import { useEffect, useState } from "react";

/** 心跳间隔（ms） */
export const TICK_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;
const listeners = new Set<() => void>();

function tick(): void {
  for (const fn of listeners) fn();
}

function subscribeTick(fn: () => void): () => void {
  listeners.add(fn);
  subscribers++;
  if (timer === null) timer = setInterval(tick, TICK_MS);
  return () => {
    listeners.delete(fn);
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 当前活跃的共享定时器个数（0 或 1，测试断言“集中 ticker”用） */
export function activeTickerCount(): number {
  return timer === null ? 0 : 1;
}

export function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    return subscribeTick(() => setNow(Date.now()));
  }, [active]);
  return now;
}
