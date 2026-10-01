/**
 * Sheet 弹层（UX 审查 AC6）：Esc 关闭 + Tab 弹层内循环 + 关闭归还焦点（键盘可达）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("Sheet 焦点管理", () => {
  it("Esc 关闭（回调 onClose）", () => {
    const onClose = vi.fn();
    render(
      <Sheet title="测试弹层" onClose={onClose}>
        <button type="button">内容按钮</button>
      </Sheet>,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab 在弹层内循环（含关闭按钮），不跑到弹层外", () => {
    const el = render(
      <Sheet title="测试弹层" onClose={() => {}}>
        <button type="button">内容按钮</button>
        <a href="https://example.com">链接</a>
      </Sheet>,
    );
    const focusables = el.querySelectorAll<HTMLElement>("button, a[href]");
    expect(focusables.length).toBeGreaterThanOrEqual(3); // ✕ + 内容按钮 + 链接
    const last = focusables[focusables.length - 1];
    act(() => {
      last.focus();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("关闭后焦点归还打开前元素（弹层卸载路径）", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    act(() => {
      trigger.focus();
    });
    const onClose = vi.fn();
    const local = render(
      <Sheet title="测试弹层" onClose={onClose}>
        <button type="button">内容按钮</button>
      </Sheet>,
    );
    expect(local.querySelector(".sheet")).not.toBeNull();
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("遮罩点击仍关闭（行为不变）", () => {
    const onClose = vi.fn();
    const el = render(
      <Sheet title="测试弹层" onClose={onClose}>
        <span>内容</span>
      </Sheet>,
    );
    act(() => {
      el.querySelector(".sheet-overlay")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
