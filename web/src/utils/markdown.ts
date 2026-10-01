/**
 * 轻量 Markdown 渲染（不引入 marked 等外部依赖，控制包体积）。
 * 支持：代码块（复制按钮 + 轻量三色语法高亮）、行内代码、粗体、斜体、链接、图片、标题、
 * 引用块、无序/有序列表、段落/换行。
 * 安全：先整体 HTML 转义，再做标记替换；链接仅放行 http(s)/mailto；
 * 图片仅放行 http(s)/data:image/相对路径（拒绝 javascript: 等其它 scheme）。
 *
 * 流式性能（UX 审查 AC5）：块级缓存 + 尾段增量——已完整解析的块（输出前缀）直接复用，
 * 只重解析尾部未完成块。解析循环唯一实现（parseLinesInto），缓存版与全量版输出逐字符一致。
 */
import { highlightCode } from "./highlight";

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

/** 图片 src 白名单：http(s)、data:image/…、相对路径；其余 scheme（javascript: 等）拒绝 */
function safeImgSrc(raw: string): string | null {
  const src = raw.trim();
  if (/^https?:\/\//i.test(src)) return escapeHtml(src);
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(src)) return escapeHtml(src);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && src !== "") return escapeHtml(src); // 无 scheme 的相对路径
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
  // 图片 ![alt](src)（在链接规则前处理，避免 `!` 干扰）
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const src = safeImgSrc(url);
    return src ? `<img class="md-img" src="${src}" alt="${alt}" loading="lazy" decoding="async" />` : m;
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

/** 转义 + 换行归一 + 切行（缓存版与全量版共用同一入口，保证行基线一致） */
function toLines(src: string): string[] {
  return escapeHtml(src.replace(/\r\n?/g, "\n")).split("\n");
}

/** 解析器跨行工作状态（段落/列表/引用在行间累积，flush 时落盘） */
interface ParseState {
  paragraph: string[];
  list: { ordered: boolean; items: string[] } | null;
  quote: string[];
}

/**
 * 解析 lines[start..] 并把输出块追加到 out（核心循环，全量/增量唯一实现）。
 *
 * onCheckpoint(i)：在"状态全空"的行边界回调（lines[0..i) 的输出已最终确定，
 * 之后的行不可能改写它）——块级缓存在此续跑，复用未变块的渲染结果。
 */
function parseLinesInto(lines: string[], start: number, out: string[], onCheckpoint?: (lineIdx: number) => void): void {
  const state: ParseState = { paragraph: [], list: null, quote: [] };

  const flushParagraph = () => {
    if (state.paragraph.length) {
      out.push(`<p>${state.paragraph.map(renderInline).join("<br/>")}</p>`);
      state.paragraph = [];
    }
  };
  const flushQuote = () => {
    if (state.quote.length) {
      out.push(`<blockquote>${state.quote.map(renderInline).join("<br/>")}</blockquote>`);
      state.quote = [];
    }
  };
  const flushList = () => {
    if (state.list) {
      const tag = state.list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${state.list.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`);
      state.list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };
  /** 状态全空 = 前缀输出定稿（块级缓存可安全续跑的边界） */
  const stateEmpty = () => state.paragraph.length === 0 && state.list === null && state.quote.length === 0;

  for (let i = start; i < lines.length; i++) {
    if (stateEmpty()) onCheckpoint?.(i);
    const line = lines[i];

    // 代码块 ``` … ```（右上角复制按钮；标注语言才做轻量高亮，纯块保持纯色）
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const raw = code.join("\n");
      const body = fence[1] !== "" ? highlightCode(raw) : raw;
      out.push(
        `<div class="code-block"><button type="button" class="code-copy" aria-label="复制代码">复制</button><pre><code>${body}</code></pre></div>`,
      );
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
      if (!state.list || state.list.ordered !== ordered) {
        flushList();
        state.list = { ordered, items: [] };
      }
      state.list.items.push((ul ?? ol)![1]);
      continue;
    }

    // 引用块 `> …`（escapeHtml 后 `>` 为 `&gt;`；连续行合并为一个 blockquote）
    const quoteLine = line.match(/^\s*(?:>|&gt;)\s?(.*)$/);
    if (quoteLine) {
      flushParagraph();
      flushList();
      state.quote.push(quoteLine[1]);
      continue;
    }

    // 空行结束段落
    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }

    flushQuote();
    state.paragraph.push(line);
  }
  flushAll();
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  parseLinesInto(toLines(src), 0, out);
  return out.join("\n");
}

/** 检查点：lines[0..lineIdx) 解析完并产出前 outLen 个块（状态全空，输出定稿） */
interface Checkpoint {
  lineIdx: number;
  outLen: number;
}

export interface MarkdownCacheStats {
  /** 累计重新解析的行数（增量部分） */
  parsedLines: number;
  /** 累计复用的已渲染块数（未变块） */
  reusedBlocks: number;
  /** 累计全量解析次数（前缀完全不匹配时的兜底） */
  fullParses: number;
  /** 累计增量解析次数 */
  cachedParses: number;
}

/**
 * Markdown 块级缓存（流式渲染用）：文本尾部增长时只重解析尾部未完成块，
 * 未变块直接复用上次渲染结果。输出与 renderMarkdown 逐字符一致（同一解析循环）。
 *
 * 用法：每个 Markdown 组件实例持有一个缓存（消息级，互不污染）。
 */
export class MarkdownRenderCache {
  /** 上次解析的转义行（前缀比对基准） */
  private lines: string[] = [];
  /** 上次解析产出的块（前缀可复用部分的渲染结果） */
  private blocks: string[] = [];
  /** 状态全空的检查点（按 lineIdx 升序） */
  private checkpoints: Checkpoint[] = [{ lineIdx: 0, outLen: 0 }];
  readonly stats: MarkdownCacheStats = { parsedLines: 0, reusedBlocks: 0, fullParses: 0, cachedParses: 0 };

  render(src: string): string {
    const lines = toLines(src);
    // 找最大的仍然有效的检查点：其行前缀与本次完全一致（用户只在尾部追加/修改时命中）
    let best = -1;
    for (let c = this.checkpoints.length - 1; c >= 0; c--) {
      const cp = this.checkpoints[c];
      if (cp.lineIdx > lines.length) continue;
      let ok = true;
      for (let j = 0; j < cp.lineIdx; j++) {
        if (this.lines[j] !== lines[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        best = c;
        break;
      }
    }

    const reused: string[] = [];
    let start = 0;
    if (best >= 0) {
      const cp = this.checkpoints[best];
      reused.push(...this.blocks.slice(0, cp.outLen));
      start = cp.lineIdx;
      this.checkpoints = this.checkpoints.slice(0, best + 1);
      this.stats.cachedParses++;
      this.stats.reusedBlocks += cp.outLen;
    } else {
      this.checkpoints = [{ lineIdx: 0, outLen: 0 }];
      this.stats.fullParses++;
    }

    const out: string[] = [];
    parseLinesInto(lines, start, out, (lineIdx) => {
      this.checkpoints.push({ lineIdx, outLen: reused.length + out.length });
    });
    this.stats.parsedLines += lines.length - start;
    this.blocks = [...reused, ...out];
    this.lines = lines;
    return this.blocks.join("\n");
  }

  /** 丢弃缓存（测试/内存紧张时用） */
  clear(): void {
    this.lines = [];
    this.blocks = [];
    this.checkpoints = [{ lineIdx: 0, outLen: 0 }];
    this.stats.parsedLines = 0;
    this.stats.reusedBlocks = 0;
    this.stats.fullParses = 0;
    this.stats.cachedParses = 0;
  }
}
