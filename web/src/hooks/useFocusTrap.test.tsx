/**
 * 弹层焦点管理（UX 审查 AC6）：Tab 弹层内循环、Esc 关闭、关闭归还焦点。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness({ active, onClose }: { active: boolean; onClose: () => void }) {
  const ref = { current: null as HTMLElement | null };
  useFocusTrap({ active, onClose, rootRef: ref });
  return (
    <div
      ref={(el) => {
        ref.current = el;
      }}
      role="dialog"
      aria-modal="true"
    >
      <button type="button">一</button>
      <button type="button">二</button>
      <button type="button">三</button>
    </div>
  );
}

function pressKey(key: string, shiftKey = false): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

describe("useFocusTrap", () => {
  it("Tab 在弹层内循环（末尾 → 首个，不跑到弹层外）", () => {
    const el = mount(<Harness active onClose={() => {}} />);
    const buttons = el.querySelectorAll<HTMLButtonElement>("button");
    act(() => {
      buttons[2].focus();
    });
    expect(document.activeElement).toBe(buttons[2]);
    pressKey("Tab");
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("Shift+Tab 反向循环（首个 → 末尾）", () => {
    const el = mount(<Harness active onClose={() => {}} />);
    const buttons = el.querySelectorAll<HTMLButtonElement>("button");
    act(() => {
      buttons[0].focus();
    });
    pressKey("Tab", true);
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("Esc 关闭弹层", () => {
    const onClose = vi.fn();
    mount(<Harness active onClose={onClose} />);
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭（卸载）后焦点归还打开前的元素", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    const onClose = vi.fn();
    mount(<Harness active onClose={onClose} />);
    // 焦点已被带进弹层
    expect(document.activeElement).not.toBe(outside);
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("active=false 不接管（Tab/ Esc 原生行为不动）", () => {
    const onClose = vi.fn();
    mount(<Harness active={false} onClose={onClose} />);
    pressKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });
});
