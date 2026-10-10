/**
 * i18n 核心单测：t() 插值、t.plural 复数（Intl.PluralRules）、语言检测、
 * localStorage 持久化恢复、语言切换 store、<html lang> 同步。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLocale,
  createT,
  detectLocale,
  getLocale,
  getLocaleSetting,
  initLocale,
  loadLocaleSetting,
  LOCALE_KEY,
  parseLocale,
  parseLocaleSetting,
  plural,
  resolveLocale,
  saveLocaleSetting,
  setLocaleSetting,
  subscribeLocale,
  translate,
  type Locale,
} from "./index";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => map,
  };
}

function htmlDoc() {
  const el = document.createElement("html");
  return { documentElement: el };
}

beforeEach(() => {
  // 模块级 store 状态在用例间复位（zh + system 偏好，nav 恒 zh-CN）
  setLocaleSetting("system", { storage: null, doc: null, nav: { language: "zh-CN" } });
});

describe("i18n: 解析与检测", () => {
  it("parseLocale / parseLocaleSetting：合法透传，非法安全回落", () => {
    expect(parseLocale("zh")).toBe("zh");
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("fr")).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocaleSetting("system")).toBe("system");
    expect(parseLocaleSetting("en")).toBe("en");
    expect(parseLocaleSetting("neon")).toBe("system");
    expect(parseLocaleSetting(undefined)).toBe("system");
  });

  it("detectLocale：首选语言前缀 zh → zh，其余 → en（language 优先于 languages）", () => {
    expect(detectLocale({ language: "zh-CN" })).toBe("zh");
    expect(detectLocale({ language: "zh-TW" })).toBe("zh");
    expect(detectLocale({ language: "en-US" })).toBe("en");
    expect(detectLocale({ language: "ja-JP" })).toBe("en");
    expect(detectLocale({ language: "en", languages: ["zh-CN"] })).toBe("en");
    expect(detectLocale({ languages: ["zh-CN", "en"] })).toBe("zh");
    expect(detectLocale({})).toBe("en");
  });

  it("resolveLocale：system 走检测，手动偏好直接透传", () => {
    expect(resolveLocale("system", { language: "zh-CN" })).toBe("zh");
    expect(resolveLocale("system", { language: "en-US" })).toBe("en");
    expect(resolveLocale("en", { language: "zh-CN" })).toBe("en");
    expect(resolveLocale("zh", { language: "en-US" })).toBe("zh");
  });
});

describe("i18n: t() 插值", () => {
  it("{name} 风格插值：字符串/数字参数均替换", () => {
    expect(translate("en", "common.itemCount.other", { count: 3 })).toBe("3 items");
    expect(translate("zh", "common.itemCount.other", { count: 3 })).toBe("3 项");
    expect(translate("en", "common.itemCount.one", { count: "1" })).toBe("1 item");
  });

  it("缺失参数保留占位符原文（便于发现漏传）；无 params 不做替换", () => {
    expect(translate("en", "common.itemCount.other")).toBe("{count} items");
    expect(translate("en", "common.itemCount.other", { other: 1 })).toBe("{count} items");
  });

  it("createT 绑定语言，t.plural 按 Intl.PluralRules 选 one/other 变体并注入 count", () => {
    const tEn = createT("en");
    const tZh = createT("zh");
    expect(tEn("nav.home")).toBe("Workbench");
    expect(tZh("nav.home")).toBe("工作台");
    // en：1 → one，0/2+ → other
    expect(tEn.plural("common.itemCount", 1)).toBe("1 item");
    expect(tEn.plural("common.itemCount", 0)).toBe("0 items");
    expect(tEn.plural("common.itemCount", 5)).toBe("5 items");
    // zh：PluralRules 恒 other
    expect(tZh.plural("common.itemCount", 1)).toBe("1 项");
    expect(tZh.plural("common.itemCount", 5)).toBe("5 项");
    // 复数也支持额外参数透传
    expect(plural("en", "common.itemCount", 2)).toBe("2 items");
    expect(typeof tEn.plural).toBe("function");
  });
});

describe("i18n: localStorage 持久化与恢复", () => {
  it("save/load 往返；key 为 agent-hub.locale.v1；无 storage 安全", () => {
    const storage = memoryStorage();
    saveLocaleSetting(storage, "en");
    expect(storage.dump().get(LOCALE_KEY)).toBe("en");
    expect(loadLocaleSetting(storage)).toBe("en");
    expect(loadLocaleSetting(memoryStorage())).toBe("system");
    expect(loadLocaleSetting(null)).toBe("system");
    expect(() => saveLocaleSetting(null, "zh")).not.toThrow();
    expect(LOCALE_KEY).toBe("agent-hub.locale.v1");
  });

  it("initLocale 从 localStorage 恢复偏好（无存档则按 navigator 检测）", () => {
    // 存档 en：忽略 zh-CN 的 navigator
    expect(initLocale({ storage: memoryStorage({ [LOCALE_KEY]: "en" }), doc: null, nav: { language: "zh-CN" } })).toBe("en");
    expect(getLocale()).toBe("en");
    expect(getLocaleSetting()).toBe("en");
    // 存档 system：走 navigator 检测
    expect(initLocale({ storage: memoryStorage({ [LOCALE_KEY]: "system" }), doc: null, nav: { language: "zh-CN" } })).toBe("zh");
    // 无存档：走 navigator 检测
    expect(initLocale({ storage: memoryStorage(), doc: null, nav: { language: "en-US" } })).toBe("en");
  });

  it("setLocaleSetting 持久化偏好（含 system 三态）", () => {
    const storage = memoryStorage();
    setLocaleSetting("zh", { storage, doc: null, nav: { language: "en-US" } });
    expect(loadLocaleSetting(storage)).toBe("zh");
    setLocaleSetting("system", { storage, doc: null, nav: { language: "en-US" } });
    expect(loadLocaleSetting(storage)).toBe("system");
  });
});

describe("i18n: 切换 store 与 <html lang> 同步", () => {
  it("setLocaleSetting 更新 getLocale 并通知订阅者（取消订阅后不再通知）", () => {
    const listener = vi.fn();
    const off = subscribeLocale(listener);
    setLocaleSetting("en", { storage: null, doc: null, nav: { language: "zh-CN" } });
    expect(getLocale()).toBe("en");
    expect(listener).toHaveBeenCalledTimes(1);
    // 同语言再设不重复通知
    setLocaleSetting("en", { storage: null, doc: null, nav: { language: "zh-CN" } });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    setLocaleSetting("zh", { storage: null, doc: null, nav: { language: "zh-CN" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("applyLocale 同步 <html lang>：zh → zh-CN，en → en", () => {
    const doc = htmlDoc();
    applyLocale("zh", doc);
    expect(doc.documentElement.lang).toBe("zh-CN");
    applyLocale("en", doc);
    expect(doc.documentElement.lang).toBe("en");
    // 无 document 环境不抛
    expect(() => applyLocale("zh")).not.toThrow();
  });

  it("setLocaleSetting / initLocale 都同步 <html lang>", () => {
    const doc = htmlDoc();
    setLocaleSetting("en", { storage: null, doc, nav: { language: "zh-CN" } });
    expect(doc.documentElement.lang).toBe("en");
    initLocale({ storage: memoryStorage({ [LOCALE_KEY]: "zh" }), doc, nav: { language: "en-US" } });
    expect(doc.documentElement.lang).toBe("zh-CN");
  });

  it("getSnapshot 稳定（useSyncExternalStore 契约）：未切换时返回同一值", () => {
    const a: Locale = getLocale();
    const b = getLocale();
    expect(a).toBe(b);
  });
});
