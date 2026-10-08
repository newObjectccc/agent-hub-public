/**
 * 代码块增强：复制按钮（独立标题栏，不遮挡代码）+ 按语言轻量高亮（无语言围栏保持纯色）。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown: 代码块增强", () => {
  it("围栏代码块包 .code-block + 标题栏「复制」按钮（aria-label 复制代码）", () => {
    const html = renderMarkdown("```\nconst a = 1;\n```");
    expect(html).toContain('<div class="code-block">');
    expect(html).toContain('<button type="button" class="code-copy" aria-label="复制代码">复制</button>');
    // 无语言围栏保持纯色（旧输出结构不变）
    expect(html).toContain("<pre><code>const a = 1;</code></pre>");
  });

  it("复制按钮位于独立标题栏 .code-head 内，与 pre 平级（不叠在代码上）", () => {
    const html = renderMarkdown("```\nfoo\n```");
    expect(html).toContain('<div class="code-head">');
    expect(html).toContain(
      '<div class="code-block"><div class="code-head"><button type="button" class="code-copy" aria-label="复制代码">复制</button></div><pre><code>foo</code></pre></div>',
    );
    // pre 内不得包含按钮（水平滚动时也不会盖住代码）
    const pre = html.slice(html.indexOf("<pre>"), html.indexOf("</pre>"));
    expect(pre).not.toContain("code-copy");
  });

  it("标注语言时标题栏左侧显示语言标签，无语言围栏不显示", () => {
    expect(renderMarkdown('```js\nlet x = 1;\n```')).toContain('<span class="code-lang">js</span>');
    expect(renderMarkdown("```\nfoo\n```")).not.toContain("code-lang");
  });

  it("标注语言的围栏做三色高亮（关键字/字符串/注释 span）", () => {
    const html = renderMarkdown('```js\nconst s = "hi"; // note\n```');
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-str">&quot;hi&quot;</span>');
    expect(html).toContain('<span class="tok-com">// note</span>');
  });

  it("多个代码块各自带独立复制按钮；行内代码不受影响", () => {
    const html = renderMarkdown("```\nfoo\n```\n\n文本 `inline`\n\n```js\nlet x = 1;\n```");
    expect(html.match(/class="code-copy"/g)).toHaveLength(2);
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain('<span class="tok-kw">let</span>');
  });

  it("复制按钮文本不含代码原文（代码仍在 pre>code 内）", () => {
    const html = renderMarkdown("```\nfoo(1)\n```");
    const btn = html.slice(html.indexOf('class="code-copy"'), html.indexOf("</button>"));
    expect(btn).not.toContain("foo(1)");
    expect(html).toContain("<pre><code>foo(1)</code></pre>");
  });
});
