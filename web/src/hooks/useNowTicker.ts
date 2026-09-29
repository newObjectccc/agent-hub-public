/**
 * 每秒滴答一次的"现在"（驱动"已运行 X 分钟"等实时标记）。
 * 仅在 active 时挂定时器；测试可通过组件的 now 注入绕过。
 */
import { useEffect, useState } from "react";

export function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
