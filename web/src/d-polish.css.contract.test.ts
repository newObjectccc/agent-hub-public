/**
 * 代码块复制按钮样式契约（遮挡回归防线）：
 * 1. .code-copy 不得绝对定位浮在代码上——历史上 position:absolute 叠右上角，
 *    水平滚动/长首行时盖住代码内容；现由 .code-head 独立标题栏承载
 * 2. .code-head min-height 44px——触屏点击热区（::after 44px）不外溢侵占代码区
 * 3. .md .code-block pre 去掉独立边框/圆角/外边距——外框统一由 .code-block 承担
 * 4. 颜色全部走主题变量（深浅色双主题），不写死色值
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "d-polish.css"), "utf8");

/** 取出选择器块体（按行首/缩进匹配，避免子串误命中） */
function blockOf(selector: string): string {
  const re = new RegExp(`(^|\\n)[ \\t]*${selector.replace(/[.*+?^${}()|[\]]/g, "\\$&")}`);
  const m = re.exec(css);
  expect(m, `d-polish.css 缺少选择器 ${selector}`).not.toBeNull();
  const idx = m!.index + m![0].length - selector.length;
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

describe("d-polish.css 代码块复制按钮契约", () => {
  it(".code-copy 不浮层（无 absolute/fixed，不遮挡代码）", () => {
    const block = blockOf(".code-copy {");
    expect(block).not.toContain("position: absolute");
    expect(block).not.toContain("position: fixed");
    expect(block).toContain("position: relative"); /* 仅作 ::after 触控热区锚点 */
  });

  it(".code-copy::after 44px 触控热区保留", () => {
    const block = blockOf(".code-copy::after");
    expect(block).toContain("44px");
  });

  it(".code-head 独立标题栏 min-height 44px（吸收触控热区，触屏常驻可见）", () => {
    const block = blockOf(".code-head {");
    expect(block).toContain("min-height: 44px");
    expect(block).toContain("border-bottom");
  });

  it(".code-block 为外框（overflow hidden 裁圆角/滚动条），pre 不再自带边框", () => {
    const container = blockOf(".code-block {");
    expect(container).toContain("overflow: hidden");
    expect(container).toContain("border: 2px solid var(--border)");
    const pre = blockOf(".md .code-block pre {");
    expect(pre).toContain("border: none");
    expect(pre).toContain("margin: 0");
  });

  it("标题栏/按钮颜色走主题变量（深浅色双主题不写死）", () => {
    for (const selector of [".code-head {", ".code-copy {", ".code-lang {", ".code-block {"]) {
      const block = blockOf(selector);
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});
