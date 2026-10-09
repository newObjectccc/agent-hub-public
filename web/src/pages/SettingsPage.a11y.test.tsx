/**
 * 设置页（SettingsPage → SettingsPanel + AppLockSettings）a11y 审查测试（P2）：
 * 逐个过可交互控件——图标按钮/输入框均须有可访问名（aria-label 或可见文本兜底），
 * 主题三态为标准 radiogroup 语义；各分区有可读名。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

vi.mock("../hooks/useAppLock", () => ({
  useAppLock: () => ({
    phase: "unlocked",
    busy: false,
    error: null,
    webauthnAvailable: true,
    configured: true,
    hasWebAuthnCredential: false,
    setup: vi.fn(async () => undefined),
    change: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    registerBiometric: vi.fn(async () => true),
    lockNow: vi.fn(),
    unlock: vi.fn(),
    biometricUnlock: vi.fn(),
    retry: vi.fn(),
  }),
}));

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

/** 可访问名：aria-label 或可见文本兜底 */
function accessibleName(el: HTMLElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

describe("SettingsPage a11y（图标按钮/输入框逐个过）", () => {
  it("所有按钮均有可访问名（无裸图标按钮）", () => {
    const el = render(<SettingsPage />);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(accessibleName(b), `按钮缺少可访问名：${b.outerHTML.slice(0, 120)}`).not.toBe("");
    }
  });

  it("所有输入框均有可访问名（aria-label 或包裹 label 文本）", () => {
    const el = render(<SettingsPage />);
    const inputs = [...el.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      const named = input.getAttribute("aria-label") ?? input.closest("label")?.textContent ?? "";
      expect(named.trim(), `输入框缺少可访问名：${input.outerHTML.slice(0, 120)}`).not.toBe("");
    }
  });

  it("主题三态是标准 radiogroup：组有可读名，选项 role=radio + aria-checked 单选", () => {
    const el = render(<SettingsPage />);
    const group = el.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute("aria-label")).toBe("主题");
    const radios = [...el.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["跟随系统", "浅色", "深色"]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("各分区有可读名（主题/提醒/应用锁/关于）", () => {
    const el = render(<SettingsPage />);
    const names = [...el.querySelectorAll<HTMLElement>("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
    expect(names).toEqual(expect.arrayContaining(["主题", "提醒", "应用锁", "关于"]));
  });
});
