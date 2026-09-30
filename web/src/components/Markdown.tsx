import { useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { renderMarkdown } from "../utils/markdown";
import { copyText } from "../utils/clipboard";
import { showToast } from "../utils/toast";

export const CODE_COPY_SUCCESS_TOAST = "已复制代码";
export const CODE_COPY_FAIL_TOAST = "复制失败，请手动选择代码";

/** 轻量 markdown 渲染组件（内容先转义后标记，见 utils/markdown.ts）。
 *  代码块右上角「复制」按钮：事件委托（HTML 由 dangerouslySetInnerHTML 生成），
 *  复制 pre>code 原文（textContent，含高亮 span 也正确）+ toast 反馈。 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);

  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement | null)?.closest?.("button.code-copy");
    if (!btn || !e.currentTarget.contains(btn)) return;
    const code = btn.parentElement?.querySelector("pre code")?.textContent ?? "";
    void copyText(code).then((ok) => showToast(ok ? CODE_COPY_SUCCESS_TOAST : CODE_COPY_FAIL_TOAST));
  };

  return <div className="md" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
