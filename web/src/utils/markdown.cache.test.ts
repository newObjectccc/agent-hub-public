/**
 * Markdown 块级缓存（UX 审查 AC5）：
 * - 渲染输出与 renderMarkdown 逐字符一致（全量/增量同一解析循环）
 * - 流式尾部增长：未变块复用渲染结果，只重解析尾部未完成块
 * - 中途编辑/截断/回退：前缀校验失败自动全量重解析（不产生旧内容残留）
 */
import { describe, expect, it } from "vitest";
import { MarkdownRenderCache, renderMarkdown } from "./markdown";

/** 各种块类型的混合文档（段落/标题/列表/引用/代码块/行内样式） */
const SAMPLE_DOC = [
  "# 标题一",
  "",
  "第一段 **粗体** 与 `代码` 与 [链接](https://example.com)。",
  "段落第二行",
  "",
  "- 列表项 1",
  "- 列表项 2",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "```js",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "## 标题二",
  "",
  "1. 有序 1",
  "2. 有序 2",
  "",
  "结尾段落",
].join("\n");

describe("MarkdownRenderCache 输出与全量解析逐字符一致", () => {
  it("整篇一次渲染 = renderMarkdown", () => {
    const cache = new MarkdownRenderCache();
    expect(cache.render(SAMPLE_DOC)).toBe(renderMarkdown(SAMPLE_DOC));
  });

  it("流式逐块增长：每一步都与全量解析逐字符一致", () => {
    const cache = new MarkdownRenderCache();
    const lines = SAMPLE_DOC.split("\n");
    for (let i = 1; i <= lines.length; i++) {
      const partial = lines.slice(0, i).join("\n");
      expect(cache.render(partial), `前 ${i} 行`).toBe(renderMarkdown(partial));
    }
  });

  it("流式按字符增长（打字机）：任何前缀都一致", () => {
    const cache = new MarkdownRenderCache();
    for (let i = 1; i <= SAMPLE_DOC.length; i += 37) {
      const partial = SAMPLE_DOC.slice(0, i);
      expect(cache.render(partial), `前 ${i} 字符`).toBe(renderMarkdown(partial));
    }
  });

  it("中途修改早期内容（前缀失效）→ 自动全量重解析，无旧内容残留", () => {
    const cache = new MarkdownRenderCache();
    cache.render(SAMPLE_DOC);
    const edited = SAMPLE_DOC.replace("标题一", "改过的标题");
    expect(cache.render(edited)).toBe(renderMarkdown(edited));
    // 再缩回短文本（截断）也一致
    const short = "# 短\n\n只剩一段";
    expect(cache.render(short)).toBe(renderMarkdown(short));
    expect(cache.render(short)).toBe(renderMarkdown(short));
  });

  it("奇形怪状的边界输入一致（未闭合代码块/列表连写/空输入）", () => {
    const cache = new MarkdownRenderCache();
    const cases = [
      "",
      "\n\n\n",
      "```\n未闭合的代码块",
      "```js\n中途\n```\n\n再一段",
      "段落\n- 列表插入\n段落继续",
      "> 引用\n段落",
      "|表格|不是|markdown|",
      "a\r\nb\r\n\r\nc",
    ];
    for (const src of cases) {
      expect(cache.render(src), JSON.stringify(src)).toBe(renderMarkdown(src));
    }
  });
});

describe("MarkdownRenderCache 块级复用（尾段增量）", () => {
  it("尾部增长只重解析尾块，未变块全部复用", () => {
    const cache = new MarkdownRenderCache();
    cache.render(SAMPLE_DOC);
    const before = { ...cache.stats };
    cache.render(`${SAMPLE_DOC}\n\n新增的最后一段`);
    expect(cache.stats.reusedBlocks - before.reusedBlocks).toBeGreaterThan(0);
    // 只解析了尾部（几行），不是全文 20+ 行
    expect(cache.stats.parsedLines - before.parsedLines).toBeLessThan(6);
    expect(cache.render(`${SAMPLE_DOC}\n\n新增的最后一段`)).toBe(
      renderMarkdown(`${SAMPLE_DOC}\n\n新增的最后一段`),
    );
  });

  it("连续流式：累计重解析行数远小于全文逐次重解析", () => {
    const cache = new MarkdownRenderCache();
    const lines = SAMPLE_DOC.split("\n");
    let fullWork = 0;
    for (let i = 1; i <= lines.length; i++) {
      const partial = lines.slice(0, i).join("\n");
      cache.render(partial);
      fullWork += i;
    }
    expect(cache.stats.parsedLines).toBeLessThan(fullWork / 3);
    expect(cache.stats.cachedParses).toBeGreaterThan(cache.stats.fullParses);
  });
});
