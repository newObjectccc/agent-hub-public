import { useMemo } from "react";
import { renderMarkdown } from "../utils/markdown";

/** 轻量 markdown 渲染组件（内容先转义后标记，见 utils/markdown.ts） */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
