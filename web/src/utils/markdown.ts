/**
 * 轻量 Markdown 渲染（不引入 marked 等外部依赖，控制包体积）。
 * 支持：代码块、行内代码、粗体、斜体、链接、标题、无序/有序列表、段落/换行。
 * 安全：先整体 HTML 转义，再做标记替换；链接仅放行 http(s)/mailto。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(href)) return escapeHtml(href);
  return null;
}

function renderInline(escaped: string): string {
  let s = escaped;
  // 行内代码（内容已转义，回填时不再二次处理）
  const codeSlots: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSlots.push(`<code>${code}</code>`);
    return `\u0000CODE${codeSlots.length - 1}\u0000`;
  });
  // 链接 [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>` : m;
  });
  // 粗体 / 斜体
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // 回填行内代码
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeSlots[Number(i)]);
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join("<br/>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块 ``` … ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }

    // 空行结束段落
    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }

    paragraph.push(line);
  }
  flushAll();
  return out.join("\n");
}
