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

  "models.title": "pi 模型",
  "models.search": "搜索模型",
  "models.select": "选择模型",
  "models.default": "使用 pi 已保存的默认模型",
  "models.automatic": "首次发送时由 pi 选择模型",
  "models.current": "会话模型",
  "models.loading": "正在加载模型…",
  "models.refresh": "刷新模型",
  "models.change": "切换模型",
  "models.save": "用于当前会话",
  "models.saving": "正在切换模型…",
  "models.cancel": "取消",
  "models.failed": "模型加载失败，请检查 Hub 连接后重试。",
  "models.scope": "只修改当前会话，不改写全局 pi 默认模型。切换后请手动重试失败消息。",
  "models.auth": "列表来自这台电脑已配置的模型；实际调用仍取决于 provider、额度和网关权限。",
  "models.savedHint": "新会话沿用 pi 已保存的默认值。终端 /model 中 Ctrl+S 才保存默认，Enter 只切当前会话。",
  "models.busy": "请结束当前轮并退出终端接管后再切换模型。",
  "models.cwd": "填写工作目录后加载这台电脑的模型。",
  "models.none": "没有匹配的模型",

  // 复数约定示例（<base>.one / <base>.other），t.plural("common.itemCount", n)
  "common.itemCount.one": "{count} 项",
  "common.itemCount.other": "{count} 项",
};
