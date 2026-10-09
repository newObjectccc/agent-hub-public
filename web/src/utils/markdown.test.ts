import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, MarkdownRenderCache } from "./markdown";

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

describe("renderMarkdown: GFM 表格", () => {
  it("渲染表头/表体，不再吐裸语法", () => {
    const html = renderMarkdown("| 名称 | 状态 |\n|---|---|\n| pi | ✅ |\n| claude | ✅ |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>pi</td>");
    expect(html).not.toContain("|---|");
    expect(html).not.toContain("| 名称 |");
  });

  it("对齐修饰：:---: 居中 / ---: 右对齐 / --- 不写样式", () => {
    const html = renderMarkdown("| A | B | C |\n|:---:|---:|---|\n| 1 | 2 | 3 |");
    expect(html).toContain('<th style="text-align:center">A</th>');
    expect(html).toContain('<th style="text-align:right">B</th>');
    expect(html).toContain("<th>C</th>");
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it("\\| 转义管道留在单元格内；缺格行补空 td 不崩", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| x \\| y |");
    expect(html).toContain("x | y");
    expect(html).toContain("<td></td>");
  });

  it("单元格内行内标记可渲染", () => {
    const html = renderMarkdown("| k | v |\n|---|---|\n| **加粗** | `code` |");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("含 | 但无分隔行 = 普通段落（不误判）", () => {
    const html = renderMarkdown("a | b 不是表格\n只是一句话");
    expect(html).not.toContain("<table");
    expect(html).toContain("a | b 不是表格");
  });

  it("流式增长：逐增量渲染与全量逐字符一致（块级缓存兼容）", () => {
    const full = "| 名称 | 状态 |\n|---|---|\n| pi | ✅ |\n| claude | ✅ |\n\n后续段落";
    for (let cut = 1; cut <= full.length; cut += 7) {
      const part = full.slice(0, cut);
      expect(renderMarkdown(part)).toBe(renderMarkdown(part)); // 同输入幂等
    }
    const cache = new MarkdownRenderCache();
    let acc = "";
    for (const ch of full) {
      acc += ch;
      const cached = cache.render(acc);
      expect(cached).toBe(renderMarkdown(acc));
    }
  });
});

describe("renderMarkdown: P2 安全加固（协议相对 URL / 占位符伪造）", () => {
  it("拒绝协议相对 //host/x 图片与链接（防第三方追踪请求）", () => {
    const html = renderMarkdown("![x](//evil.test/a.png)\n\n[y](//evil.test/b)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
  });

  it("拒绝反斜杠协议相对变体（浏览器把 \\ 归一为 /）", () => {
    const html = renderMarkdown("![x](\\\\evil.test/a.png)\n\n[y](\\\\evil.test/b)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
  });

  it("控制字符剥除后判定 scheme（防控制字符前缀绕过）", () => {
    const html = renderMarkdown("![x](\u0001javascript:alert(1))\n\n[y](\u0001javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });

  it("输入伪造 \\u0000CODE 占位符不产生显示混淆（预处理剥离）", () => {
    // 伪造占位符想冒充第一个行内代码槽；预处理剥 \u0000 后按普通文本渲染
    const html = renderMarkdown("\u0000CODE0\u0000 `真实代码`");
    expect(html).toContain("CODE0");
    expect(html).toContain("<code>真实代码</code>");
    expect(html.startsWith("<p>CODE0 ")).toBe(true);
    // 真实行内代码照常回填；输出不含 NUL
    expect(html).not.toContain("\u0000");
  });

  it("伪造输入下块级缓存与全量渲染仍逐字符一致", () => {
    const src = "开头 \u0000CODE0\u0000 `x` \u0000CODE99999\u0000 结尾";
    const cache = new MarkdownRenderCache();
    expect(cache.render(src)).toBe(renderMarkdown(src));
  });
});
