/**
 * 首屏加载骨架 / JS 加载失败兜底（首屏可靠性 #1、#2）：
 * index.html 静态加载态纯 CSS 不依赖 JS；inline 脚本在主资源失败/超时时换友好错误卡（含重试）。
 * - 契约：骨架文案、双主题可见、prefers-reduced-motion、错误卡文案、重试 → location.reload、XSS 面为零
 * - 行为：把 index.html 的 body 灌入 jsdom 并执行 inline 脚本，驱动失败/超时路径断言 DOM
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

/** 提取 inline 兜底脚本（唯一无 src 的 <script>） */
function inlineBootScript(): string {
  const m = /<script>\s*([\s\S]*?)<\/script>/.exec(html);
  expect(m, "index.html 缺少 inline 首屏兜底脚本").not.toBeNull();
  return m![1];
}

/** 提取 <body> 内容（含骨架与 script 标签） */
function bodyHtml(): string {
  const m = /<body>([\s\S]*?)<\/body>/.exec(html);
  expect(m, "index.html 缺少 <body>").not.toBeNull();
  return m![1];
}

type BootWindow = Window & {
  __APP_BOOTED__?: boolean;
  __APP_BOOT_FAIL__?: () => void;
  __APP_BOOT_RETRY__?: () => void;
};

const bootWin = (): BootWindow => window as BootWindow;

/** 灌入 index.html 的 body 并执行 inline 脚本（模拟浏览器解析 + 普通 script 执行） */
function boot(): void {
  document.body.innerHTML = bodyHtml();
  new Function(inlineBootScript())();
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete bootWin().__APP_BOOTED__;
  delete bootWin().__APP_BOOT_FAIL__;
  delete bootWin().__APP_BOOT_RETRY__;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("index.html 首屏加载骨架（不依赖 JS）", () => {
  it("#root 内静态放加载卡片（文案「Agent Hub 加载中…」），React 挂载后自然覆盖", () => {
    expect(html).toContain('<div id="root">');
    const body = bodyHtml();
    expect(body).toContain("Agent Hub 加载中…");
    expect(body).toContain('class="boot-shell"');
    expect(body).toContain('class="boot-bar"');
  });

  it("骨架样式自包含（inline <style>，外部 CSS 挂了也能显示）且深浅主题都可见", () => {
    // 自包含样式：不依赖外部 CSS 加载
    expect(html).toMatch(/<style>[\s\S]*\.boot-shell[\s\S]*<\/style>/);
    // 浅色默认 + 系统深色 + 手动深色/浅色全覆盖
    expect(html).toContain(".boot-shell {");
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain(':root[data-theme="dark"] .boot-shell');
    expect(html).toContain(':root[data-theme="light"] .boot-shell');
    // 深浅两套底色都显式声明（黑屏根因：深色底 + 无内容）
    expect(html).toMatch(/\.boot-shell \{[\s\S]*?background: #fff7e8/);
    expect(html).toMatch(/:root\[data-theme="dark"\] \.boot-shell \{[\s\S]*?background: #17140d/);
  });

  it("加载动画尊重 prefers-reduced-motion（减弱动态时静止）", () => {
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.boot-bar-fill\s*\{[\s\S]*?animation: none/);
  });
});

describe("index.html JS 加载失败兜底（纯 inline，外部 JS 挂了也能工作）", () => {
  it("契约：主 script 带 data-app-entry 标记，inline 脚本监听其 error + 超时轮询 __APP_BOOTED__", () => {
    const script = inlineBootScript();
    expect(html).toContain('<script type="module" src="/src/main.tsx" data-app-entry>');
    expect(script).toContain('script[data-app-entry]');
    expect(script).toContain('"error"');
    expect(script).toContain("__APP_BOOTED__");
    expect(script).toContain("setTimeout");
  });

  it("契约：错误卡文案「资源加载失败，请检查网络后重试」，重试 = location.reload()", () => {
    const script = inlineBootScript();
    expect(script).toContain("资源加载失败，请检查网络后重试");
    expect(script).toContain('retry.textContent = "重试"');
    expect(script).toContain("window.location.reload()");
  });

  it("XSS 安全面为零：无 innerHTML/文档写入，DOM 全部 createElement/textContent（无用户输入）", () => {
    const script = inlineBootScript();
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("document.write");
    expect(script).not.toContain("eval(");
    expect(script).toContain("createElement");
    expect(script).toContain("textContent");
  });

  it("行为：初始显示加载骨架，__APP_BOOTED__ 握手标志为 false", () => {
    boot();
    expect(bootWin().__APP_BOOTED__).toBe(false);
    expect(document.getElementById("root")!.textContent).toContain("Agent Hub 加载中…");
  });

  it("行为：主资源加载失败（entry script error）→ 立即显示错误卡 + 重试按钮", () => {
    boot();
    const entry = document.querySelector("script[data-app-entry]")!;
    entry.dispatchEvent(new Event("error"));

    const alert = document.querySelector('#root [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("资源加载失败，请检查网络后重试");
    const retry = alert!.querySelector("button");
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toBe("重试");
  });

  it("行为：重试按钮走 __APP_BOOT_RETRY__（默认实现 location.reload）", () => {
    boot();
    const retrySpy = vi.fn();
    bootWin().__APP_BOOT_RETRY__ = retrySpy;

    bootWin().__APP_BOOT_FAIL__!();
    document.querySelector<HTMLButtonElement>("#root button")!.click();

    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it("行为：JS 慢/挂起超时未启动 → 显示错误卡（绝不是黑屏）", () => {
    vi.useFakeTimers();
    boot();

    vi.advanceTimersByTime(30_000);

    const alert = document.querySelector('#root [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("资源加载失败，请检查网络后重试");
  });

  it("行为：React 启动（__APP_BOOTED__=true）后超时不弹错误卡", () => {
    vi.useFakeTimers();
    boot();
    bootWin().__APP_BOOTED__ = true;

    vi.advanceTimersByTime(30_000);

    expect(document.querySelector('#root [role="alert"]')).toBeNull();
  });

  it("行为：错误卡只出一次（重复触发不叠加节点）", () => {
    boot();
    bootWin().__APP_BOOT_FAIL__!();
    bootWin().__APP_BOOT_FAIL__!();

    expect(document.querySelectorAll("#root [role=\"alert\"]").length).toBe(1);
  });
});
