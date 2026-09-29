import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "./markdown";

describe("renderMarkdown（轻量渲染）", () => {
  it("转义 HTML，防止注入", () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("渲染代码块与行内代码", () => {
    const html = renderMarkdown("运行 `pnpm test`\n```\nconst a = 1;\n```");
    expect(html).toContain("<pre><code>const a = 1;</code></pre>");
    expect(html).toContain("<code>pnpm test</code>");
  });

  it("渲染标题、列表、粗体与链接", () => {
    const html = renderMarkdown("# 标题\n- 项目 **A**\n- 项目 B\n\n见 [文档](https://example.com)");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>A</strong>");
    expect(html).toContain('<a href="https://example.com"');
  });

  it("拒绝 javascript: 协议链接（不产生 <a>，保持纯文本）", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });

  it("escapeHtml 转义全部特殊字符", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});
