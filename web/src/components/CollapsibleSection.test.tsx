/**
 * 可折叠小节测试（今日概览折叠/展开）：标题行 toggle、箭头指示、localStorage 状态持久、默认展开。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollapsibleSection } from "./CollapsibleSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "test.collapse.open";

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

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("CollapsibleSection 可折叠小节", () => {
  it("默认展开：aria-expanded=true，内容在文档流内（无 .closed）", () => {
    const el = render(
      <CollapsibleSection title="今日概览" storageKey={KEY}>
        <div>概览内容</div>
      </CollapsibleSection>,
    );
    const btn = el.querySelector(".section-toggle") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("概览内容");
    expect(el.querySelector(".collapse-body")!.className).not.toContain("closed");
  });

  it("点击标题行 toggle：收起 + 箭头回位；再点展开 + 箭头朝下", () => {
    const el = render(
      <CollapsibleSection title="今日概览" storageKey={KEY}>
        <div>概览内容</div>
      </CollapsibleSection>,
    );
    const btn = el.querySelector(".section-toggle") as HTMLButtonElement;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".collapse-body")!.className).toContain("closed");
    expect(el.querySelector(".collapse-body")!.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".collapse-arrow")!.className).not.toContain("open");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".collapse-body")!.className).not.toContain("closed");
    expect(el.querySelector(".collapse-arrow")!.className).toContain("open");
  });

  it("状态存 localStorage（\"1\" 展开 / \"0\" 收起），重挂按存储恢复", () => {
    const el = render(
      <CollapsibleSection title="今日概览" storageKey={KEY}>
        <div>概览内容</div>
      </CollapsibleSection>,
    );
    const btn = el.querySelector(".section-toggle") as HTMLButtonElement;
    expect(localStorage.getItem(KEY)).toBeNull(); // 未交互不写存储
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(localStorage.getItem(KEY)).toBe("0");
    // 重挂（模拟刷新）→ 恢复收起态
    rerender(
      <CollapsibleSection title="今日概览" storageKey={KEY}>
        <div>概览内容</div>
      </CollapsibleSection>,
    );
    act(() => {
      root?.unmount();
      container?.remove();
    });
    const el2 = render(
      <CollapsibleSection title="今日概览" storageKey={KEY}>
        <div>概览内容</div>
      </CollapsibleSection>,
    );
    expect(el2.querySelector(".section-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
});
