/**
 * J1 顶栏图标按钮统一规范——CSS 契约（防止尺寸/边框/阴影/对齐再次漂移）：
 * 1. .icon-btn token：44×44 实心盒（触控达标即视觉盒）、2px 描边、硬阴影、图标居中
 * 2. 历史六个按钮（返回/树/git/⋯/模式切换/中止）全部并入同一规则组
 * 3. ::after 外扩热区退役（实心盒取代），reduced-motion 降级存在
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "j1-header.css"), "utf8");

/** 取出选择器块体（首个匹配的 { ... }） */
function blockOf(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `j1-header.css 缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

describe("J1 .icon-btn 统一 token 契约", () => {
  it("实心 44×44 盒（触控 ≥44px 不回退）", () => {
    const block = blockOf(".icon-btn,");
    expect(block).toContain("width: 44px");
    expect(block).toContain("height: 44px");
    expect(block).toContain("min-height: 44px");
    expect(block).toContain("flex-shrink: 0");
  });

  it("同边框同阴影同圆角，深浅色走 palette token", () => {
    const block = blockOf(".icon-btn,");
    expect(block).toContain("border: 2px solid var(--border)");
    expect(block).toContain("box-shadow: var(--nb-shadow-xs)");
    expect(block).toContain("border-radius: var(--nb-radius)");
    expect(block).toContain("background: var(--card)");
    expect(block).toContain("color: var(--card-foreground)");
  });

  it("图标居中同字号（flex 双向居中 + 18px SVG）", () => {
    expect(blockOf(".icon-btn,")).toContain("align-items: center");
    expect(blockOf(".icon-btn,")).toContain("justify-content: center");
    const iconBlock = blockOf(".icon-btn svg,");
    expect(iconBlock).toContain("width: 18px");
    expect(iconBlock).toContain("height: 18px");
  });
});

describe("J1 六按钮并入同一规则组 + 热区口径退役", () => {
  it("返回/树/git/⋯/模式切换/中止全部命中统一规则", () => {
    const group = blockOf(".icon-btn,");
    expect(group).not.toBe("");
    for (const sel of [
      ".chat-header .back",
      ".chat-header .chat-tree-btn",
      ".chat-header .chat-git-btn",
      ".chat-header .attach-trigger",
      ".chat-header .tool-btn",
      ".modebar-right .abort-btn",
    ]) {
      expect(css, sel).toContain(sel);
    }
  });

  it("::after 外扩热区退役（content: none，实心盒即热区）", () => {
    const block = blockOf(".chat-header .back::after,");
    expect(block).toContain("content: none");
  });

  it("reduced-motion 降级：统一按钮 transition 关闭", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*?transition: none/);
  });
});
