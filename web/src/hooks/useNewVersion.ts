/**
 * 产物新版本自检（「不丢代码 + 永远跑最新代码」原则的机制化）：
 * 进入前台/定时取一次 index.html（no-store），对比入口脚本 hash 与当前运行的入口脚本——
 * 不一致 = 服务端已换新构建（发版 / 并行构建竞态 / SW 陈旧），提示用户一键刷新。
 * 陈旧产物从「玄学体验问题」变成「可见的一行提示」。
 */
import { useEffect, useState } from "react";

/** 从 index.html 提取入口脚本路径（纯函数，可测）；无则 null */
export function extractEntryScript(html: string): string | null {
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
  return m ? m[1] : null;
}

/** 当前运行产物的入口脚本路径（相对路径口径，与 extractEntryScript 对齐） */
export function currentEntryScript(doc: Document = document): string | null {
  const el = doc.querySelector('script[src*="/assets/index-"]');
  if (!el) return null;
  const src = el.getAttribute("src") ?? "";
  return src.startsWith("/") ? src : new URL(src, location.href).pathname;
}

/** 是否存在新版本（true = 展示「点击刷新」提示） */
export function useNewVersion(checkMs = 60_000): boolean {
  const [newVersion, setNewVersion] = useState(false);
  useEffect(() => {
    let stopped = false;
    const check = async (): Promise<void> => {
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        const latest = extractEntryScript(html);
        const current = currentEntryScript();
        if (!stopped && latest !== null && current !== null && latest !== current) setNewVersion(true);
      } catch {
        // 离线/瞬断：静默（下次再查）
      }
    };
    void check();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void check(), checkMs);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [checkMs]);
  return newVersion;
}
