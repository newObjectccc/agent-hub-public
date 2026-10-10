/**
 * English 语言包（MessageKey 的唯一事实来源）。
 *
 * key 规范：扁平点分小写 `<域>.<名>`（如 `common.retry`）；
 * 复数用 `<base>.one` / `<base>.other` 约定变体，由 `t.plural(base, n)` 按
 * `Intl.PluralRules` 选变体（缺失变体回落 `<base>.other`）。
 *
 * 新增 key 必须同步补 zh.ts：`Record<MessageKey, string>` 编译期防漏翻/多翻，
 * 运行时另有 i18n/messages.test.ts 做 key 集合一致性守护（CI 防漏翻）。
 */
export const en = {
  // AppShell 一级菜单（drawer / sidebar 共用）
  "nav.home": "Workbench",
  "nav.sessions": "Sessions",
  "nav.system": "System",
  "nav.terminal": "Terminal",
  "nav.settings": "Settings",

  // AppShell 顶栏页面标题
  "page.title.home": "Workbench",
  "page.title.sessions": "Sessions",
  "page.title.system": "System",
  "page.title.terminal": "Terminal",
  "page.title.settings": "Settings",
  "page.title.chat": "Session Detail",
  "page.title.tree": "Session Branches",

  // 设置页：语言（Language）三态
  "settings.locale": "Language",
  "settings.locale.system": "Follow system",
  "settings.locale.zh": "Chinese",
  "settings.locale.en": "English",

  // 复数约定示例（<base>.one / <base>.other），t.plural("common.itemCount", n)
  "common.itemCount.one": "{count} item",
  "common.itemCount.other": "{count} items",
} as const;

/** en 的 key 联合类型：t() 参数用它，写错 key 编译报错 */
export type MessageKey = keyof typeof en;
