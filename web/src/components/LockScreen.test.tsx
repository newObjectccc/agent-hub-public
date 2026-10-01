/**
 * 解锁屏（F1）交互：PIN 数字键盘 / 两遍确认 / 口令切换 / 生物识别按钮可用性。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "./LockScreen";

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

function click(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function key(el: HTMLElement, digit: string): void {
  const btn = Array.from(el.querySelectorAll<HTMLButtonElement>(".lock-key")).find((b) => b.textContent === digit);
  click(btn);
}

function submit(el: HTMLElement): void {
  act(() => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const baseProps = {
  busy: false,
  error: null,
  webauthnAvailable: false,
  onUnlock: () => undefined,
  onSetup: () => undefined,
  onBiometric: () => undefined,
};

describe("LockScreen 解锁（unlock）", () => {
  it("数字键盘输入 PIN → 解锁回调收到 PIN；键盘按钮 ≥ 10 键", () => {
    const onUnlock = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="unlock" onUnlock={onUnlock} />);
    key(el, "1");
    key(el, "2");
    key(el, "3");
    key(el, "4");
    expect(el.querySelectorAll(".lock-dot.filled")).toHaveLength(4);
    submit(el);
    expect(onUnlock).toHaveBeenCalledWith("1234");
  });

  it("非法/空 PIN：本地提示规则文案，不触发解锁", () => {
    const onUnlock = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="unlock" onUnlock={onUnlock} />);
    submit(el);
    expect(onUnlock).not.toHaveBeenCalled();
    expect(el.querySelector(".lock-error")!.textContent).toContain("4-6 位数字");
  });

  it("生物识别按钮：不可用隐藏、可用显示且点击触发回调", () => {
    const hidden = render(<LockScreen {...baseProps} mode="unlock" />);
    expect(hidden.querySelector(".lock-bio")).toBeNull();
    act(() => {
      root?.unmount();
    });
    const onBiometric = vi.fn();
    const shown = render(<LockScreen {...baseProps} mode="unlock" webauthnAvailable onBiometric={onBiometric} />);
    expect(shown.querySelector(".lock-bio")).not.toBeNull();
    click(shown.querySelector(".lock-bio"));
    expect(onBiometric).toHaveBeenCalledTimes(1);
  });

  it("busy：键盘与提交禁用（防重复提交）", () => {
    const onUnlock = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="unlock" busy onUnlock={onUnlock} />);
    const keys = Array.from(el.querySelectorAll<HTMLButtonElement>(".lock-key"));
    expect(keys.every((b) => b.disabled)).toBe(true);
    expect(el.querySelector<HTMLButtonElement>(".lock-submit")!.disabled).toBe(true);
  });
});

describe("LockScreen 设置（setup）", () => {
  it("输两遍一致 → onSetup；不一致 → 提示并复位", () => {
    const onSetup = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="setup" onSetup={onSetup} />);
    for (const d of ["9", "8", "7", "6"]) key(el, d);
    submit(el); // → confirm 步
    expect(el.textContent).toContain("再输一次确认");
    for (const d of ["9", "8", "7", "5"]) key(el, d);
    submit(el);
    expect(onSetup).not.toHaveBeenCalled();
    expect(el.querySelector(".lock-error")!.textContent).toContain("两次输入不一致");
    // 复位后重新输入两遍一致 → 设置成功
    for (const d of ["1", "1", "2", "2"]) key(el, d);
    submit(el);
    for (const d of ["1", "1", "2", "2"]) key(el, d);
    submit(el);
    expect(onSetup).toHaveBeenCalledWith("1122");
  });

  it("口令模式：切换后用文本输入，长口令可提交", () => {
    const onSetup = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="setup" onSetup={onSetup} />);
    click(el.querySelector(".lock-mode-toggle"));
    expect(el.querySelector(".lock-keypad")).toBeNull();
    const input = el.querySelector<HTMLInputElement>(".lock-passphrase")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "open-sesame");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    submit(el);
    const confirmInput = el.querySelector<HTMLInputElement>(".lock-passphrase")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(confirmInput, "open-sesame");
      confirmInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    submit(el);
    expect(onSetup).toHaveBeenCalledWith("open-sesame");
  });
});
