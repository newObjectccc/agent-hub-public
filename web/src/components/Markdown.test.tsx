/**
 * Markdown 代码块「复制」按钮：事件委托复制 pre>code 原文 + toast 反馈。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_COPY_FAIL_TOAST, CODE_COPY_SUCCESS_TOAST, Markdown } from "./Markdown";
import { dismissToast, getToasts } from "../utils/toast";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  getToasts().forEach((t) => dismissToast(t.id));
});

describe("Markdown 代码块复制", () => {
  it("点击 .code-copy 复制代码原文（textContent，不含高亮标签）并 toast 成功", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const el = render(<Markdown text={'```js\nconst s = "hi";\n```'} />);
    const btn = el.querySelector<HTMLButtonElement>("button.code-copy")!;
    expect(btn.textContent).toBe("复制");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('const s = "hi";');
    expect(getToasts().some((t) => t.text === CODE_COPY_SUCCESS_TOAST)).toBe(true);
  });

  it("复制失败（无 clipboard 且 execCommand 不可用）→ 失败 toast，静默不抛", async () => {
    const el = render(<Markdown text={"```\nfoo\n```"} />);
    const btn = el.querySelector<HTMLButtonElement>("button.code-copy")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getToasts().some((t) => t.text === CODE_COPY_FAIL_TOAST)).toBe(true);
  });

  it("点击非复制区域不触发复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const el = render(<Markdown text={"普通段落"} />);
    await act(async () => {
      el.querySelector(".md")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("多个代码块按钮各复制各的代码（委托按最近 .code-block 定位）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const el = render(<Markdown text={"```\nAAA\n```\n\n```\nBBB\n```"} />);
    const buttons = el.querySelectorAll<HTMLButtonElement>("button.code-copy");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("BBB");
  });
});
