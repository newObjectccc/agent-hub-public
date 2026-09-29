/**
 * 搜索结果渲染与 chat 页定位的纯函数（可单测）。
 * snippet 由 server 生成，命中词以 [[...]] 包裹（见 docs/API_CONTRACT.md §1.6）。
 */

export interface SnippetSegment {
  text: string;
  hit: boolean;
}

/**
 * 解析摘要高亮标记 → 片段列表。
 * 未闭合的 [[ 视为普通文本（消息原文里出现方括号不致渲染错乱）。
 */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  let rest = snippet;
  for (;;) {
    const open = rest.indexOf("[[");
    if (open < 0) break;
    const close = rest.indexOf("]]", open + 2);
    if (close < 0) break;
    if (open > 0) out.push({ text: rest.slice(0, open), hit: false });
    const hit = rest.slice(open + 2, close);
    if (hit !== "") out.push({ text: hit, hit: true });
    rest = rest.slice(close + 2);
  }
  if (rest !== "") out.push({ text: rest, hit: false });
  return out;
}

/** 大小写不敏感定位首个包含 q 的消息 id（?q= 兜底锚点） */
export function findMessageByText(messages: Array<{ id: string; text: string }>, q: string): string | null {
  const needle = q.trim().toLowerCase();
  if (needle === "") return null;
  for (const m of messages) {
    if (m.text.toLowerCase().includes(needle)) return m.id;
  }
  return null;
}

const ROLE_LABELS: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  toolResult: "工具",
  custom: "自定义",
  system: "系统",
  other: "其他",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
