/**
 * 中文语言包：结构受 `Record<MessageKey, string>` 约束——
 * 漏 key（缺翻译）或多 key（en 未同步）都在 `npm run lint`（tsc）编译期报错。
 */
import type { MessageKey } from "./en";

export const zh: Record<MessageKey, string> = {
  // AppShell 一级菜单（drawer / sidebar 共用）
  "nav.home": "工作台",
  "nav.sessions": "会话",
  "nav.system": "系统",
  "nav.terminal": "终端",
  "nav.settings": "设置",

  // AppShell 顶栏页面标题
  "page.title.home": "工作台",
  "page.title.sessions": "会话",
  "page.title.system": "系统",
  "page.title.terminal": "终端",
  "page.title.settings": "设置",
  "page.title.chat": "会话详情",
  "page.title.tree": "会话分支",

  // 设置页：语言（Language）三态
  "settings.locale": "语言",
  "settings.locale.system": "跟随系统",
  "settings.locale.zh": "中文",
  "settings.locale.en": "English",

  // 复数约定示例（<base>.one / <base>.other），t.plural("common.itemCount", n)
  "common.itemCount.one": "{count} 项",
  "common.itemCount.other": "{count} 项",
};
