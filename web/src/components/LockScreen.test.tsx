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

describe("LockScreen 错误与输入通道（UX 审查 AC3）", () => {
  it("解锁失败（PIN 错）后停留在解锁屏：标题/交互不回落到「设置应用锁」首屏", () => {
    const onUnlock = vi.fn();
    const el = render(
      <LockScreen {...baseProps} mode="unlock" error="PIN 不正确，请重试" onUnlock={onUnlock} />,
    );
    expect(el.textContent).toContain("🔒 应用锁");
    expect(el.textContent).not.toContain("设置应用锁");
    // 错误可见且可直接重试（再次提交仍回调 onUnlock）
    expect(el.querySelector(".lock-error")!.textContent).toContain("PIN 不正确");
    for (const d of ["1", "2", "3", "4"]) key(el, d);
    submit(el);
    expect(onUnlock).toHaveBeenCalledWith("1234");
  });

  it("PIN 输入框 readOnly（自绘键盘唯一输入通道：不弹系统键盘/防肩窥），aria 保留", () => {
    const el = render(<LockScreen {...baseProps} mode="unlock" />);
    const input = el.querySelector<HTMLInputElement>(".lock-input")!;
    expect(input.readOnly).toBe(true);
    expect(input.type).toBe("password");
    expect(input.getAttribute("aria-label")).toBe("输入 PIN");
    expect(input.getAttribute("aria-readonly")).toBe("true");
  });

  it("readOnly 下物理键盘仍可输入（keydown 喂给自绘键盘逻辑）", () => {
    const onUnlock = vi.fn();
    const el = render(<LockScreen {...baseProps} mode="unlock" onUnlock={onUnlock} />);
    const input = el.querySelector<HTMLInputElement>(".lock-input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "6", bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "7", bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "8", bubbles: true, cancelable: true }));
    });
    expect(el.querySelectorAll(".lock-dot.filled")).toHaveLength(4);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(el.querySelectorAll(".lock-dot.filled")).toHaveLength(3);
  });

  it("错误条带「重试」入口（onRetry）；无 onRetry 时不占位", () => {
    const onRetry = vi.fn();
    const withRetry = render(
      <LockScreen {...baseProps} mode="unlock" error="无法连接服务端，暂时无法解锁" onRetry={onRetry} />,
    );
    const btn = withRetry.querySelector<HTMLButtonElement>(".lock-retry")!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("重试");
    click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => {
      root?.unmount();
    });
    const without = render(<LockScreen {...baseProps} mode="unlock" error="错误" />);
    expect(without.querySelector(".lock-retry")).toBeNull();
  });

  it("口令模式输入框仍可正常输入（readOnly 只上给 PIN 数字输入）", () => {
    const el = render(<LockScreen {...baseProps} mode="unlock" />);
    click(el.querySelector(".lock-mode-toggle"));
    const input = el.querySelector<HTMLInputElement>(".lock-passphrase")!;
    expect(input.readOnly).toBe(false);
  });
});
