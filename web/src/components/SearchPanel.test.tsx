/**
 * 搜索面板（UX 审查 AC6）：Tab 面板内循环、Esc 关闭、关闭归还焦点（与 Sheet 同口径）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    search: mocks.search,
  },
}));

import { SearchPanel } from "./SearchPanel";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(open: boolean, onClose: () => void): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SearchPanel open={open} onClose={onClose} />);
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  mocks.search.mockReset();
  mocks.search.mockResolvedValue({ results: [] });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("SearchPanel 焦点管理", () => {
  it("Esc 关闭面板", async () => {
    const onClose = vi.fn();
    await render(true, onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab 在面板内循环（关闭按钮 ↔ 输入框），不跑到面板外", async () => {
    const el = await render(true, () => {});
    const focusables = el.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const last = focusables[focusables.length - 1];
    act(() => {
      last.focus();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("关闭（卸载）后焦点归还打开前元素", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    act(() => {
      trigger.focus();
    });
    await render(true, () => {});
    expect(document.activeElement).not.toBe(trigger);
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
