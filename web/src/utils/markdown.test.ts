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

describe("renderMarkdown: 图片（消息内嵌图正常渲染）", () => {
  it("http(s)/data:image/相对路径渲染为 img，max-width 类名就位", () => {
    const html = renderMarkdown("看 ![截图](https://x.test/a.png) 和 ![内嵌](data:image/png;base64,aGVsbG8=)");
    expect(html).toContain('<img class="md-img" src="https://x.test/a.png"');
    expect(html).toContain('<img class="md-img" src="data:image/png;base64,aGVsbG8="');
    const rel = renderMarkdown("![本地](./shots/a.png)");
    expect(rel).toContain('src="./shots/a.png"');
  });

  it("拒绝 javascript:/data:text 等非图片 scheme（保持纯文本）", () => {
    const html = renderMarkdown("![x](javascript:alert(1)) ![y](data:text/html,xx)");
    expect(html).not.toContain("<img");
    expect(html).toContain("![x](javascript:alert(1))");
  });
});

describe("renderMarkdown: 引用块（引用回复）", () => {
  it("连续 `> ` 行合并为 blockquote", () => {
    const html = renderMarkdown("> 原文第一行\n> 原文第二行\n\n回复内容");
    expect(html).toContain("<blockquote>原文第一行<br/>原文第二行</blockquote>");
    expect(html).toContain("<p>回复内容</p>");
  });

  it("空 `>` 行保留换行；嵌套引用也可渲染", () => {
    const html = renderMarkdown("> a\n>\n> b");
    expect(html).toBe("<blockquote>a<br/><br/>b</blockquote>");
  });
});
