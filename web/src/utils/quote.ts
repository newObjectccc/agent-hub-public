/**
 * 引用回复（长按消息 → "引用"）：Markdown 引用格式拼接（纯函数，便于单测）。
 * 两端 agent（pi / claude）都按 Markdown 理解 `> ` 引用行。
 */

/** 引用条摘要最大长度（超出加省略号） */
export const QUOTE_SUMMARY_LIMIT = 60;
/** 引用块最大行数（防超长引用淹没输入） */
export const QUOTE_MAX_LINES = 6;

/** 摘要：压成单行、截断 */
export function quoteSummary(text: string, limit = QUOTE_SUMMARY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

/** 文本 → Markdown 引用块（每行 `> `，空行 `>`） */
export function toMarkdownQuote(text: string, maxLines = QUOTE_MAX_LINES): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = lines.slice(0, maxLines);
  const body = kept.map((line) => (line.trim() === "" ? ">" : `> ${line}`)).join("\n");
  return lines.length > maxLines ? `${body}\n> …` : body;
}

/** 发送文本 = 引用块 + 空行 + 正文 */
export function withQuote(quote: string, text: string): string {
  const block = toMarkdownQuote(quote);
  const body = text.trim();
  return body === "" ? block : `${block}\n\n${body}`;
}
