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

  "workspace.parallelHint": "Continue through Hub on this computer. Both devices still share the working directory.",
  "workspace.attachHint": "Continue the same chat through the connected terminal or Hub driver.",
  "workspace.attachUnavailable": "Takeover is unavailable. Check the agent setup on your computer and close any conflicting chat first.",
  "workspace.title": "Current workspace",
  "workspace.unknown": "Branch unverified",
  "workspace.directory": "Non-Git directory",
  "workspace.detached": "Detached",
  "workspace.project": "Project",
  "workspace.branch": "Current Git branch",
  "workspace.cwd": "Working directory",
  "workspace.repository": "Repository",
  "workspace.worktree": "Worktree",
  "workspace.session": "Chat",
  "workspace.mode": "Drive mode",
  "workspace.refresh": "Refresh",
  "workspace.confirm": "Continue in this workspace",
  "workspace.close": "Back to chat",
  "workspace.git": "Git changes",
  "workspace.tree": "Chat branches",
  "workspace.parallel": "Parallel",
  "workspace.attach": "Takeover",
  "workspace.changed": "Working directory or branch changed",
  "workspace.review": "Review",
  "workspace.changedDetail": "Your draft is preserved. The workspace has changed:",
  "workspace.unavailable": "Workspace could not be verified. Refresh before sending.",
  "workspace.queuedReview": "Review the destination of this queued message before retrying:",
  "workspace.legacyQueue": "This older message has no recorded workspace.",
  "workspace.checking": "Checking workspace…",

  "models.title": "pi model",
  "models.search": "Search models",
  "models.select": "Choose a model",
  "models.default": "Use saved pi default",
  "models.automatic": "pi will select a model on first send",
  "models.current": "Session model",
  "models.loading": "Loading models…",
  "models.refresh": "Refresh models",
  "models.change": "Change model",
  "models.save": "Use for this session",
  "models.saving": "Changing model…",
  "models.cancel": "Cancel",
  "models.failed": "Could not load models. Check the Hub connection and retry.",
  "models.scope": "Changes only this session. Your global pi default stays unchanged. Retry a failed message manually after switching.",
  "models.auth": "Lists models configured on this computer. Provider access, quota, and gateway permissions can still affect requests.",
  "models.savedHint": "New sessions use pi’s saved default. In the terminal /model picker, Ctrl+S saves a default; Enter changes only that session.",
  "models.busy": "Finish the current run and leave terminal takeover before changing the model.",
  "models.cwd": "Enter a working directory to load this computer’s models.",
  "models.none": "No matching models",

  // 复数约定示例（<base>.one / <base>.other），t.plural("common.itemCount", n)
  "common.itemCount.one": "{count} item",
  "common.itemCount.other": "{count} items",
} as const;

/** en 的 key 联合类型：t() 参数用它，写错 key 编译报错 */
export type MessageKey = keyof typeof en;
