import { memo, useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "../utils/markdown";
import { probeRender } from "../utils/renderProbe";

/**
 * 轻量 markdown 渲染组件（内容先转义后标记，见 utils/markdown.ts）。
 *
 * 渲染性能：React.memo + 按 text 的 useMemo 解析缓存——历史消息 text 未变时
 * 不再重复 parseMarkdown / 重建 dangerouslySetInnerHTML DOM。
 * 图片宽高比占位：加载完成打 .img-loaded、失败打 .img-error（load/error 不冒泡，
 * 用捕获委托），CSS 里未加载图片按 16:10 占位防跳动，load/error 后恢复布局。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  probeRender("Markdown");
  const html = useMemo(() => renderMarkdown(text), [text]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const mark = (img: HTMLImageElement, ok: boolean) => img.classList.add(ok ? "img-loaded" : "img-error");
    // 缓存命中时 load 已完成（不会再来事件）：挂载时补打标记（naturalWidth=0 视为失败）
    el.querySelectorAll<HTMLImageElement>("img.md-img").forEach((img) => {
      if (img.complete) mark(img, img.naturalWidth > 0);
    });
    const onLoad = (e: Event) => {
      const target = e.target;
      if (target instanceof HTMLImageElement && target.classList.contains("md-img")) mark(target, true);
    };
    const onError = (e: Event) => {
      const target = e.target;
      if (target instanceof HTMLImageElement && target.classList.contains("md-img")) mark(target, false);
    };
    el.addEventListener("load", onLoad, true);
    el.addEventListener("error", onError, true);
    return () => {
      el.removeEventListener("load", onLoad, true);
      el.removeEventListener("error", onError, true);
    };
  }, [html]);

  return <div className="md" ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
});
