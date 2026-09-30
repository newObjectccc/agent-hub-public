/**
 * 代码块增强：复制按钮包装 + 按语言轻量高亮（无语言围栏保持纯色，兼容旧输出）。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown: 代码块增强", () => {
  it("围栏代码块包 .code-block + 右上角「复制」按钮（aria-label 复制代码）", () => {
    const html = renderMarkdown("```\nconst a = 1;\n```");
    expect(html).toContain('<div class="code-block">');
    expect(html).toContain('<button type="button" class="code-copy" aria-label="复制代码">复制</button>');
    // 无语言围栏保持纯色（旧输出结构不变）
    expect(html).toContain("<pre><code>const a = 1;</code></pre>");
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
