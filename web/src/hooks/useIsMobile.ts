/**
 * 移动端密度断点（<768px）：行高/密度随视口切换（drawer/sidebar 同断点）。
 * jsdom / 老浏览器无 matchMedia 时回落桌面密度（单测行为稳定）。
 */
import { useEffect, useState } from "react";

export const MOBILE_BREAKPOINT = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(MOBILE_BREAKPOINT).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE_BREAKPOINT);
    const onChange = (): void => setMobile(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    // Safari <14 回落
    if (typeof mq.addListener === "function") {
      mq.addListener(onChange);
      return () => mq.removeListener(onChange);
    }
    return;
  }, []);
  return mobile;
}
