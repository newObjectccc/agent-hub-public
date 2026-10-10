/**
 * i18n 核心（轻量自研，零重依赖）：
 * - 扁平 key（`MessageKey` = en 的 key 联合类型，t() 写错 key 编译报错）
 * - `t(key, params?)`：`{name}` 风格插值（缺失参数保留占位符原文，便于发现漏传）
 * - `t.plural(base, n)`：`Intl.PluralRules` 选 `<base>.one` / `<base>.other` 约定变体，
 *   缺失变体回落 `<base>.other`；默认注入 `count` 参数
 * - 语言检测：`navigator.language` 前缀 zh → zh，否则 en
 * - 切换 API（`initLocale` / `setLocaleSetting`）+ `<html lang>` 同步 + localStorage 持久化
 *   （`agent-hub.locale.v1`，取值 system | zh | en）
 * - 模块级 store + 订阅：React 层（provider.tsx）之外的代码也能读当前语言/感知切换
 */
import { en, type MessageKey } from "./en";
import { zh } from "./zh";

export type { MessageKey } from "./en";

export type Locale = "zh" | "en";
/** 语言偏好三态：跟随系统 / 手动中文 / 手动英文 */
export type LocaleSetting = "system" | Locale;
export type MessageParams = Record<string, string | number>;

export const LOCALE_KEY = "agent-hub.locale.v1";

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { zh, en };

const LOCALE_VALUES: readonly Locale[] = ["zh", "en"];

/** 复数 base key：所有形如 `<base>.other` 的 key 去掉变体后缀 */
type PluralVariant<K> = K extends `${infer B}.other` ? B : never;
export type PluralBaseKey = PluralVariant<MessageKey>;

export interface NavLike {
  language?: string;
  languages?: readonly string[];
}

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;
type LocaleDoc = Pick<Document, "documentElement">;

/** 未知/非法语言安全回落 null（纯函数） */
export function parseLocale(raw: unknown): Locale | null {
  return typeof raw === "string" && (LOCALE_VALUES as readonly string[]).includes(raw)
    ? (raw as Locale)
    : null;
}

/** 未知/非法偏好安全回落 system（纯函数） */
export function parseLocaleSetting(raw: unknown): LocaleSetting {
  return raw === "system" ? "system" : parseLocale(raw) ?? "system";
}

/** 语言检测：首选语言（navigator.language，languages[0] 兜底）前缀 zh → zh，否则 en */
export function detectLocale(nav?: NavLike | null): Locale {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : null);
  const primary = n?.language ?? n?.languages?.[0];
  return typeof primary === "string" && /^zh\b/i.test(primary) ? "zh" : "en";
}

/** 偏好 → 实际语言（system 时按 navigator 检测） */
export function resolveLocale(setting: LocaleSetting, nav?: NavLike | null): Locale {
  return setting === "system" ? detectLocale(nav) : setting;
}

export function loadLocaleSetting(storage: LocaleStorage | null | undefined): LocaleSetting {
  if (!storage) return "system";
  try {
    return parseLocaleSetting(storage.getItem(LOCALE_KEY));
  } catch {
    return "system";
  }
}

export function saveLocaleSetting(
  storage: LocaleStorage | null | undefined,
  setting: LocaleSetting,
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCALE_KEY, setting);
  } catch {
    // 写入失败忽略
  }
}

/** 同步 `<html lang>`（zh → zh-CN，与 index.html 默认一致） */
export function applyLocale(locale: Locale, doc?: LocaleDoc | null): void {
  const target = doc ?? (typeof document !== "undefined" ? document : null);
  if (!target) return;
  target.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** 纯翻译：key 缺失（运行时兜底）返回 key 原文，绝不抛错 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = MESSAGES[locale][key] ?? en[key] ?? key;
  return interpolate(template, params);
}

/** 复数：Intl.PluralRules 选 `<base>.one`/`<base>.other` 变体，默认注入 count */
export function plural(
  locale: Locale,
  base: PluralBaseKey,
  n: number,
  params?: MessageParams,
): string {
  const category = new Intl.PluralRules(locale === "zh" ? "zh-CN" : "en-US").select(n);
  const candidate = `${base}.${category}`;
  const key = (candidate in MESSAGES[locale] ? candidate : `${base}.other`) as MessageKey;
  return translate(locale, key, { count: n, ...params });
}

export interface TFunction {
  (key: MessageKey, params?: MessageParams): string;
  plural(base: PluralBaseKey, n: number, params?: MessageParams): string;
}

/** 绑定语言的翻译函数（含 .plural 复数） */
export function createT(locale: Locale): TFunction {
  const t = ((key: MessageKey, params?: MessageParams) => translate(locale, key, params)) as TFunction;
  t.plural = (base, n, params) => plural(locale, base, n, params);
  return t;
}

// ---------- 模块级 store：当前语言 + 订阅（React 之外也能感知切换） ----------

let currentLocale: Locale = detectLocale();
let currentSetting: LocaleSetting = "system";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function getLocaleSetting(): LocaleSetting {
  return currentSetting;
}

/** 订阅语言切换，返回取消订阅函数 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface LocaleRuntime {
  /** 默认 localStorage；显式传 null 表示不持久化 */
  storage?: LocaleStorage | null;
  /** 默认 document */
  doc?: LocaleDoc | null;
  /** 默认 navigator（system 偏好检测用） */
  nav?: NavLike | null;
}

function runtimeStorage(rt: LocaleRuntime): LocaleStorage | null {
  return rt.storage !== undefined ? rt.storage : typeof localStorage !== "undefined" ? localStorage : null;
}

function runtimeDoc(rt: LocaleRuntime): LocaleDoc | null {
  return rt.doc !== undefined ? rt.doc : typeof document !== "undefined" ? document : null;
}

function runtimeNav(rt: LocaleRuntime): NavLike | null {
  return rt.nav !== undefined ? rt.nav : typeof navigator !== "undefined" ? navigator : null;
}

function commit(setting: LocaleSetting, rt: LocaleRuntime): Locale {
  const locale = resolveLocale(setting, runtimeNav(rt));
  const changed = locale !== currentLocale || setting !== currentSetting;
  currentSetting = setting;
  currentLocale = locale;
  applyLocale(locale, runtimeDoc(rt));
  if (changed) for (const listener of [...listeners]) listener();
  return locale;
}

/**
 * 应用启动 / Provider 挂载时调用：从 localStorage 恢复偏好（无存档按 navigator 检测），
 * 同步 `<html lang>`。恢复路径不回写 localStorage。
 */
export function initLocale(rt: LocaleRuntime = {}): Locale {
  return commit(loadLocaleSetting(runtimeStorage(rt)), rt);
}

/** 切换语言偏好：持久化 + 更新 store + 同步 `<html lang>` + 通知订阅者 */
export function setLocaleSetting(setting: LocaleSetting, rt: LocaleRuntime = {}): Locale {
  saveLocaleSetting(runtimeStorage(rt), setting);
  return commit(parseLocaleSetting(setting), rt);
}
