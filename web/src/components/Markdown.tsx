import { memo, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { MarkdownRenderCache, renderMarkdown } from "../utils/markdown";
import { copyText } from "../utils/clipboard";
import { showToast } from "../utils/toast";
import { probeRender } from "../utils/renderProbe";

export const CODE_COPY_SUCCESS_TOAST = "已复制代码";
export const CODE_COPY_FAIL_TOAST = "复制失败，请手动选择代码";

/**
 * 轻量 markdown 渲染（内容先转义后标记）。
 * 渲染性能：memo + 按 text 的 useMemo（历史消息不重复 parse）；
 * 流式增量（UX 审查 AC5）：每实例一个块级缓存，尾部增长只重解析尾块，未变块复用渲染结果
 * （输出与全量解析逐字符一致）。
 * 代码块右上角「复制」：事件委托 + toast（HTML 由 dangerouslySetInnerHTML 生成）。
 * 图片宽高比占位：load 打 .img-loaded、error 打 .img-error（捕获委托防跳动）。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  probeRender("Markdown");
  const cacheRef = useRef<MarkdownRenderCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new MarkdownRenderCache();
  const html = useMemo(() => cacheRef.current?.render(text) ?? renderMarkdown(text), [text]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const mark = (img: HTMLImageElement, ok: boolean) => img.classList.add(ok ? "img-loaded" : "img-error");
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

  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement | null)?.closest?.("button.code-copy");
    if (!btn || !e.currentTarget.contains(btn)) return;
    const code = btn.parentElement?.querySelector("pre code")?.textContent ?? "";
    void copyText(code).then((ok) => showToast(ok ? CODE_COPY_SUCCESS_TOAST : CODE_COPY_FAIL_TOAST));
  };

  return <div className="md" ref={rootRef} onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
