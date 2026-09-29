/** 主题设置（跟随系统/浅色/深色）单测 */
import { describe, expect, it } from "vitest";
import { applyTheme, loadTheme, parseTheme, saveTheme, THEME_KEY } from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("theme: 解析与持久化", () => {
  it("parseTheme：合法值透传，非法回落 system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme("neon")).toBe("system");
    expect(parseTheme(null)).toBe("system");
  });

  it("load/save 往返；无 storage 安全", () => {
    const storage = memoryStorage();
    saveTheme(storage, "dark");
    expect(loadTheme(storage)).toBe("dark");
    expect(loadTheme(memoryStorage())).toBe("system");
    expect(loadTheme(null)).toBe("system");
    expect(() => saveTheme(null, "light")).not.toThrow();
  });

  it("applyTheme：system 移除 data-theme，light/dark 写入", () => {
    const el = document.createElement("html");
    const doc = { documentElement: el };
    applyTheme("dark", doc);
    expect(el.getAttribute("data-theme")).toBe("dark");
    applyTheme("light", doc);
    expect(el.getAttribute("data-theme")).toBe("light");
    applyTheme("system", doc);
    expect(el.hasAttribute("data-theme")).toBe(false);
    // 无 document 环境不抛
    expect(() => applyTheme("dark")).not.toThrow();
    expect(THEME_KEY).toBe("agent-hub.theme");
  });
});
