/**
 * 关键样式契约（H1 UI 精修三根因防回归）：
 * 1. --app-pad-top 必须在 :root 可取到——否则 .sessions-page 高度 calc 失效 →
 *    列表内部滚动退化成整页滚动（"触点要放屏幕边缘才能滚"的根因）
 * 2. 滚动容器/卡片 touch-action: pan-y——触点落在卡片上也能纵向拖动
 * 3. .tab-slider.misaligned 纯 CSS 兜底——滑块测量失配时 active 态仍正确
 * 4. html/body 横向滚动兜底——任何页面任何状态无横向滚动
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");

/** 取出选择器块体（按行首/缩进匹配，避免子串误命中） */
function blockOf(selector: string): string {
  const re = new RegExp(`(^|\\n)[ \\t]*${selector.replace(/[.*+?^${}()|[\]]/g, "\\$&")}`);
  const m = re.exec(css);
  expect(m, `styles.css 缺少选择器 ${selector}`).not.toBeNull();
  const idx = m!.index + m![0].length - selector.length;
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

describe("styles.css 布局/滚动/滑块契约", () => {
  it(":root 定义 --app-pad-top（会话列表高度 calc 的前提）", () => {
    // 同一个 :root 块内必须能取到（历史 bug：只定义在 .app，取不到）
    expect(/:root\s*\{[^}]*--app-pad-top/.test(css)).toBe(true);
  });

  it(".sessions-page 高度 calc 使用带 fallback 的 var()（变量缺失也不失效）", () => {
    const block = blockOf(".sessions-page {");
    expect(block).toContain("100dvh");
    expect(block).toContain("var(--app-pad-top, 12px)");
  });

  it("列表滚动容器 touch-action: pan-y（卡片中央起手也能拖动滚动）", () => {
    expect(blockOf(".session-list-scroll {")).toContain("touch-action: pan-y");
    expect(blockOf(".virtual-scroll {")).toContain("touch-action: pan-y");
    expect(blockOf(".chat-messages {")).toContain("touch-action: pan-y");
  });

  it("会话卡片 button 不吞纵向平移手势", () => {
    expect(blockOf(".session-item {")).toContain("touch-action: pan-y");
  });

  it("下拉刷新容器高度链传递（flex 传递到内部滚动容器）", () => {
    const ptr = blockOf(".ptr {");
    expect(ptr).toContain("display: flex");
    expect(ptr).toContain("min-height: 0");
    const content = blockOf(".ptr-content {");
    expect(content).toContain("display: flex");
  });

  it("tab 滑块测量失配有纯 CSS 兜底（active 态不依赖滑块）", () => {
    expect(css).toContain(".tab-slider.misaligned");
    expect(css).toContain(".tab-slider.misaligned ~ .tab-btn.active");
  });

  it("chat 顶栏徽章簇可换行（窄屏不横向溢出）", () => {
    const header = blockOf(".chat-header {");
    expect(header).toContain("flex-wrap: wrap");
    expect(css).toContain(".chat-badges {");
  });

  it("html/body 横向滚动全局兜底", () => {
    expect(css).toContain("overflow-x: clip");
  });

  it("长按菜单遮罩不吞纵向拖动（chat 消息区拖动兑底）", () => {
    const backdrop = blockOf(".msg-menu-backdrop {");
    // 块内锚定正则（toContain 子串可被注释/其他声明误命中）
    expect(backdrop).toMatch(/(^|\n)\s*touch-action:\s*pan-y\s*;/);
    expect(backdrop).toMatch(/(^|\n)\s*pointer-events:\s*none\s*;/);
  });

  it("消息脚部行禁选（选字只发生在气泡正文，脚部是 UI 装饰件）", () => {
    const foot = blockOf(".msg-foot {");
    expect(foot).toMatch(/(^|\n)\s*user-select:\s*none\s*;/);
    expect(foot).toMatch(/(^|\n)\s*-webkit-touch-callout:\s*none\s*;/);
  });

  it("复制/更多按钮 44px 触控热区（::after 外扩 + position:relative 锚点）", () => {
    const btn = blockOf(".msg-copy-btn,\n.msg-more-btn {");
    expect(btn).toMatch(/(^|\n)\s*position:\s*relative\s*;/);
    for (const sel of [".msg-copy-btn::after {", ".msg-more-btn::after {"]) {
      const hot = blockOf(sel);
      expect(hot, sel).toMatch(/(^|\n)\s*width:\s*44px\s*;/);
      expect(hot, sel).toMatch(/(^|\n)\s*height:\s*44px\s*;/);
      expect(hot, sel).toMatch(/(^|\n)\s*content:\s*""\s*;/);
      expect(hot, sel).toMatch(/(^|\n)\s*position:\s*absolute\s*;/);
    }
  });

  it("复制/更多热区水平互不重叠（各自向外偏置，more 不抢 copy 右缘）", () => {
    // copy 热区向左偏（left 为负）、more 热区自左缘起（left: 0）——44px 宽互不相交
    const copy = blockOf(".msg-copy-btn::after {");
    expect(copy).toMatch(/(^|\n)\s*left:\s*-\d+px\s*;/);
    const more = blockOf(".msg-more-btn::after {");
    expect(more).toMatch(/(^|\n)\s*left:\s*0\s*;/);
  });

  it("长按菜单不超屏（max-width + wrap，旧居中定位改 JS 锚定按压点）", () => {
    const menu = blockOf(".msg-menu {");
    expect(menu).toMatch(/(^|\n)\s*max-width:\s*calc\(100vw - 16px\)\s*;/);
    expect(menu).toMatch(/(^|\n)\s*flex-wrap:\s*wrap\s*;/);
    // 负向：不得恢复旧的居中定位（长消息菜单飞出屏幕的根因）
    expect(menu).not.toMatch(/top:\s*50%/);
    expect(menu).not.toMatch(/left:\s*50%/);
  });

  it("气泡正文不禁选（部分文字复制的前提；负向契约）", () => {
    const bubble = blockOf(".bubble {");
    expect(bubble).not.toMatch(/user-select/);
    expect(bubble).not.toMatch(/touch-callout/);
  });

  it("消息图片不加选择/指针拦截（长按交还系统菜单；负向契约）", () => {
    const img = blockOf(".msg-img {");
    expect(img).not.toMatch(/user-select|touch-callout|pointer-events|touch-action/);
  });
});

describe("会话页 flex 布局回归（tab 组不被压缩）", () => {
  it(".sessions-page 头部区域 flex-shrink: 0，但不罩住 .ptr（高度链不被级联打翻）", () => {
    // 根因回归：`.sessions-page > *` 同特异性后写胜，会覆盖 .ptr 的 flex: 1 1 auto
    // → shrink 被罩成 0 → 高度链失效 → 内部滚动死。必须用 :not(.ptr) 排除。
    expect(css).not.toMatch(/\.sessions-page > \*\s*\{/);
    const block = blockOf(".sessions-page > *:not(.ptr) {");
    expect(block).toContain("flex-shrink: 0");
  });
});

describe("顶部提示手动关闭契约（横幅/toast/提示行热区）", () => {
  it("toast ✕ 热区 ≥44px（::after 外扩，视觉盒不撑高）且可点（宿主 pointer-events:none 下）", () => {
    const hot = blockOf(".toast-close::after {");
    expect(hot).toContain("width: 44px");
    expect(hot).toContain("height: 44px");
    const block = blockOf(".toast-close {");
    expect(block).toContain("pointer-events: auto");
    expect(block).toContain("position: relative");
  });

  it("toast 整条可接收滑动手势（pointer-events: auto + touch-action: pan-y）", () => {
    const block = blockOf(".toast {");
    expect(block).toContain("pointer-events: auto");
    expect(block).toContain("touch-action: pan-y");
  });

  it("横幅 touch-action: pan-y（横向留给滑动关闭，纵向滚动不被吞）", () => {
    expect(blockOf(".notice-banner {")).toContain("touch-action: pan-y");
  });

  it("提示行 ✕ 热区 ≥44px（::after 外扩）且触控不被全局 min-height 撑高", () => {
    const hot = blockOf(".chat-notice-close::after {");
    expect(hot).toContain("width: 44px");
    expect(hot).toContain("height: 44px");
    expect(blockOf(".chat-notice-close {")).toContain("position: relative");
  });
});

describe("REV-I1 防回归：触控热区定位上下文", () => {
  it(".attach-trigger 必须保持 position: relative（::after 不得逃逸到 chat-header）", () => {
    const css = readFileSync(join(process.cwd(), "src", "i1-layout.css"), "utf8");
    const m = /\.attach-trigger\s*\{([^}]*)\}/.exec(css);
    expect(m, ".attach-trigger 规则必须存在").toBeTruthy();
    expect(m![1]).toMatch(/position:\s*relative/);
  });
});

describe("REV-I1b 防回归：徽章簇收缩级联", () => {
  it(".chat-badges 的 flex 不得含 0 1 auto（会覆盖 flex-shrink:0 致 ⋯ 按钮被裁）", () => {
    const css = readFileSync(join(process.cwd(), "src", "i1-layout.css"), "utf8");
    const m = /\.chat-badges\s*\{([^}]*)\}/.exec(css);
    expect(m, ".chat-badges 规则必须存在").toBeTruthy();
    expect(m![1]).not.toMatch(/flex:\s*0\s*1\s*auto/);
    expect(m![1]).toMatch(/flex:\s*0\s*0\s*auto/);
  });
});
