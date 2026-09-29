/**
 * 主题设置（跟随系统 / 浅色 / 深色）：localStorage 持久化 + data-theme 覆盖。
 * styles.css 侧用 `:root[data-theme=...]` 与 `prefers-color-scheme` 双通道取色。
 */

export type ThemeSetting = "system" | "light" | "dark";

export const THEME_KEY = "agent-hub.theme";

const THEME_VALUES: readonly ThemeSetting[] = ["system", "light", "dark"];

/** 未知/非法主题安全回落 system（纯函数） */
export function parseTheme(raw: unknown): ThemeSetting {
  return typeof raw === "string" && (THEME_VALUES as readonly string[]).includes(raw)
    ? (raw as ThemeSetting)
    : "system";
}

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeDoc = Pick<Document, "documentElement">;

export function loadTheme(storage: ThemeStorage | null | undefined): ThemeSetting {
  if (!storage) return "system";
  try {
    return parseTheme(storage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

export function saveTheme(storage: ThemeStorage | null | undefined, theme: ThemeSetting): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // 写入失败忽略
  }
}

/** 应用主题到 <html>（system 时移除 data-theme，交回 prefers-color-scheme） */
export function applyTheme(theme: ThemeSetting, doc?: ThemeDoc): void {
  const target =
    doc ?? (typeof document !== "undefined" ? document : null);
  if (!target) return;
  if (theme === "system") {
    target.documentElement.removeAttribute("data-theme");
  } else {
    target.documentElement.setAttribute("data-theme", theme);
  }
}
