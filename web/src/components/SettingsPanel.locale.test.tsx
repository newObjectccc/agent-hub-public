/**
 * 设置页语言切换 UI 单测（i18n 管线端到端）：
 * 设置页「语言 Language」三态选择（跟随系统 / 中文 / English）——
 * 切换即时双语生效、localStorage 持久化（agent-hub.locale.v1）、<html lang> 同步、重挂恢复。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../pages/SettingsPage";
import { I18nProvider } from "../i18n/provider";
import { LOCALE_KEY, setLocaleSetting } from "../i18n";

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

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => map,
  };
}

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

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

function localeSelect(): HTMLSelectElement {
  const select = container!.querySelector<HTMLSelectElement>("select.locale-select");
  expect(select, "设置页缺少语言选择 select.locale-select").not.toBeNull();
  return select!;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll("option")].map((o) => o.textContent?.trim() ?? "");
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  setLocaleSetting("system", { storage: null, doc: null, nav: { language: "zh-CN" } });
  document.documentElement.lang = "";
});

afterEach(() => {
  unmount();
  document.documentElement.lang = "";
});

describe("设置页语言选择（Language 三态）", () => {
  it("语言分区可见：select 可访问名 + 三选项（跟随系统 / 中文 / English）", () => {
    render(
      <I18nProvider storage={null} nav={{ language: "zh-CN" }}>
        <SettingsPage />
      </I18nProvider>,
    );
    const select = localeSelect();
    expect(select.getAttribute("aria-label")).toBe("语言");
    expect(optionLabels(select)).toEqual(["跟随系统", "中文", "English"]);
    expect(select.value).toBe("system");
    const section = container!.querySelector('section[aria-label="语言"]');
    expect(section).not.toBeNull();
    expect(section!.querySelector(".notif-panel-title")?.textContent).toBe("语言");
  });

  it("切换 English：文案即时双语生效 + <html lang> 同步 + localStorage 持久化", () => {
    const storage = memoryStorage();
    render(
      <I18nProvider storage={storage} nav={{ language: "zh-CN" }}>
        <SettingsPage />
      </I18nProvider>,
    );
    changeSelect(localeSelect(), "en");
    // 语言分区自身文案切英文（管线通）
    expect(container!.querySelector('section[aria-label="Language"]')).not.toBeNull();
    expect(optionLabels(localeSelect())).toEqual(["Follow system", "Chinese", "English"]);
    expect(localeSelect().value).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(storage.dump().get(LOCALE_KEY)).toBe("en");
  });

  it("localStorage 恢复：重挂设置页按存档语言渲染（手动 en 优先于 zh-CN 检测）", () => {
    const storage = memoryStorage({ [LOCALE_KEY]: "en" });
    render(
      <I18nProvider storage={storage} nav={{ language: "zh-CN" }}>
        <SettingsPage />
      </I18nProvider>,
    );
    expect(localeSelect().value).toBe("en");
    expect(optionLabels(localeSelect())).toEqual(["Follow system", "Chinese", "English"]);
    expect(document.documentElement.lang).toBe("en");
    // 切回中文同样即时生效
    changeSelect(localeSelect(), "zh");
    expect(optionLabels(localeSelect())).toEqual(["跟随系统", "中文", "English"]);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(storage.dump().get(LOCALE_KEY)).toBe("zh");
    unmount();
    // 再次重挂仍按存档恢复
    render(
      <I18nProvider storage={storage} nav={{ language: "en-US" }}>
        <SettingsPage />
      </I18nProvider>,
    );
    expect(localeSelect().value).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
