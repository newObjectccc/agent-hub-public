/**
 * i18n React 层单测：I18nProvider + useT()/useLocale()——
 * 语言切换全树更新、localStorage 持久化恢复、<html lang> 同步、无 Provider fallback。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, useLocale, useT } from "./provider";
import { getLocale, LOCALE_KEY, setLocaleSetting, type LocaleSetting } from "./index";

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

/** 探针：展示翻译文案 + 偏好，按钮触发切换（验证全树更新） */
function Probe({ id }: { id: string }) {
  const t = useT();
  const { setting, setSetting } = useLocale();
  return (
    <div>
      <span id={`${id}-home`}>{t("nav.home")}</span>
      <span id={`${id}-settings`}>{t("page.title.settings")}</span>
      <span id={`${id}-count`}>{t.plural("common.itemCount", 3)}</span>
      <span id={`${id}-setting`}>{setting}</span>
      {(["system", "zh", "en"] as LocaleSetting[]).map((s) => (
        <button key={s} type="button" id={`${id}-to-${s}`} onClick={() => setSetting(s)}>
          {s}
        </button>
      ))}
    </div>
  );
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

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function text(id: string): string {
  return container!.querySelector(`#${id}`)?.textContent ?? "";
}

beforeEach(() => {
  setLocaleSetting("system", { storage: null, doc: null, nav: { language: "zh-CN" } });
  document.documentElement.lang = "";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  document.documentElement.lang = "";
});

describe("I18nProvider + useT：渲染与插值", () => {
  it("挂载即按偏好渲染文案，t.plural 按语言选复数变体", () => {
    render(
      <I18nProvider storage={null} nav={{ language: "zh-CN" }}>
        <Probe id="p" />
      </I18nProvider>,
    );
    expect(text("p-home")).toBe("工作台");
    expect(text("p-settings")).toBe("设置");
    expect(text("p-count")).toBe("3 项");
    expect(text("p-setting")).toBe("system");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("英文偏好下渲染英文文案与复数 one/other", () => {
    render(
      <I18nProvider storage={null} nav={{ language: "en-US" }}>
        <Probe id="p" />
      </I18nProvider>,
    );
    expect(text("p-home")).toBe("Workbench");
    expect(text("p-count")).toBe("3 items");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("语言切换：全树更新 + 持久化 + <html lang>", () => {
  it("setSetting 切语言全树更新（多处挂载点同步刷新）", () => {
    render(
      <I18nProvider storage={null} nav={{ language: "zh-CN" }}>
        <Probe id="a" />
        <Probe id="b" />
      </I18nProvider>,
    );
    expect(text("a-home")).toBe("工作台");
    expect(text("b-home")).toBe("工作台");
    click(container!.querySelector("#a-to-en"));
    expect(text("a-home")).toBe("Workbench");
    expect(text("b-home")).toBe("Workbench");
    expect(text("a-setting")).toBe("en");
    expect(text("b-setting")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    click(container!.querySelector("#b-to-zh"));
    expect(text("a-home")).toBe("工作台");
    expect(text("b-home")).toBe("工作台");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("切换写入 localStorage（agent-hub.locale.v1，含 system 三态）", () => {
    const storage = memoryStorage();
    render(
      <I18nProvider storage={storage} nav={{ language: "zh-CN" }}>
        <Probe id="p" />
      </I18nProvider>,
    );
    click(container!.querySelector("#p-to-en"));
    expect(storage.dump().get(LOCALE_KEY)).toBe("en");
    click(container!.querySelector("#p-to-system"));
    expect(storage.dump().get(LOCALE_KEY)).toBe("system");
  });

  it("localStorage 恢复：重挂 Provider 按存档语言渲染（手动 > 跟随系统检测）", () => {
    const storage = memoryStorage({ [LOCALE_KEY]: "en" });
    render(
      <I18nProvider storage={storage} nav={{ language: "zh-CN" }}>
        <Probe id="p" />
      </I18nProvider>,
    );
    expect(text("p-home")).toBe("Workbench");
    expect(text("p-setting")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("system 存档按 navigator 检测恢复", () => {
    const storage = memoryStorage({ [LOCALE_KEY]: "system" });
    render(
      <I18nProvider storage={storage} nav={{ language: "zh-TW" }}>
        <Probe id="p" />
      </I18nProvider>,
    );
    expect(text("p-home")).toBe("工作台");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

describe("useT 无 Provider fallback", () => {
  it("裸挂组件也翻译并随模块级切换更新（既有单测无需逐个包 Provider）", () => {
    render(<Probe id="p" />);
    expect(text("p-home")).toBe("工作台");
    act(() => {
      setLocaleSetting("en", { storage: null, doc: null, nav: { language: "zh-CN" } });
    });
    expect(text("p-home")).toBe("Workbench");
    expect(getLocale()).toBe("en");
  });
});
