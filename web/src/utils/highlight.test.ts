/**
 * 轻量语法高亮：关键字 / 字符串 / 注释三色，不引重型库。
 * 输入是 escapeHtml 之后的代码文本。
 */
import { describe, expect, it } from "vitest";
import { escapeHtml } from "./markdown";
import { highlightCode } from "./highlight";

describe("highlightCode（三色轻量高亮）", () => {
  it("关键字 → tok-kw span", () => {
    expect(highlightCode("const a = 1;")).toBe('<span class="tok-kw">const</span> a = 1;');
  });

  it("字符串 → tok-str span（转义引号形态也识别）", () => {
    expect(highlightCode('let s = &quot;hi&quot;;')).toContain('<span class="tok-str">&quot;hi&quot;</span>');
    expect(highlightCode("&#39;single&#39;")).toBe('<span class="tok-str">&#39;single&#39;</span>');
    expect(highlightCode("`tpl`")).toBe('<span class="tok-str">`tpl`</span>');
  });

  it("注释 //、/* */、行首 # → tok-com span；行中 #（CSS 颜色）不误伤", () => {
    expect(highlightCode("x // note")).toContain('<span class="tok-com">// note</span>');
    expect(highlightCode("/* block */")).toBe('<span class="tok-com">/* block */</span>');
    expect(highlightCode("# shell comment")).toContain('<span class="tok-com"># shell comment</span>');
    // 行中 #fff：CSS 颜色不按注释处理
    expect(highlightCode("color: #fff;")).not.toContain("tok-com");
  });

  it("注释/字符串内的关键字不高亮（优先吞并）", () => {
    expect(highlightCode("// const x")).toBe('<span class="tok-com">// const x</span>');
    expect(highlightCode("&quot;const&quot;")).toBe('<span class="tok-str">&quot;const&quot;</span>');
  });

  it("跨行块注释整体一个 span；前置换行原样保留（行首 # 注释）", () => {
    const html = highlightCode("a\n# c1\nb");
    expect(html).toContain('\n<span class="tok-com"># c1</span>');
    expect(html.startsWith("a")).toBe(true);
    const multi = highlightCode("/* l1\nl2 */");
    expect(multi).toBe('<span class="tok-com">/* l1\nl2 */</span>');
  });

  it("普通标识符/未知词不包 span（纯色保持）", () => {
    expect(highlightCode("fooBar(1)")).toBe("fooBar(1)");
    expect(highlightCode("")).toBe("");
  });

  it("escapeHtml 与高亮配合：注入文本不产生真实标签", () => {
    const html = highlightCode(escapeHtml('<script>const x = "</script>"</script>'));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });
});
