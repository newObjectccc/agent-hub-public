/**
 * 快捷指令（常用 prompt 模板）：内置 + 用户自定义（localStorage 持久化）。
 * 存储与合并逻辑为纯函数，便于单测；UI 只做渲染。
 */

export interface QuickCommand {
  id: string;
  text: string;
  builtin: boolean;
}

export const QUICK_COMMANDS_STORAGE_KEY = "agent-hub.quickCommands.v1";

/** 内置模板（按产品需求固定） */
export const BUILTIN_COMMANDS: readonly QuickCommand[] = [
  { id: "builtin-continue", text: "继续", builtin: true },
  { id: "builtin-test-fix", text: "跑测试并修复失败", builtin: true },
  { id: "builtin-summary", text: "总结当前进展", builtin: true },
  { id: "builtin-hold", text: "先别动，等我确认", builtin: true },
];

/** 只依赖 Storage 的 getItem/setItem 子集，测试可注入 fake */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function customCommandId(text: string): string {
  return `custom:${text}`;
}

/** 读自定义指令（存储损坏/缺省 → 空列表） */
export function loadCustomCommands(storage: StorageLike): string[] {
  try {
    const raw = storage.getItem(QUICK_COMMANDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
  } catch {
    return [];
  }
}

/**
 * 安全获取 localStorage：getter 本身在禁 cookie/sandbox 场景会抛 SecurityError。
 * 返回 null 表示存储不可用（调用方降级为仅内存模式）。
 */
export function safeStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 保存自定义指令：任何异常（quota/隐私模式）静默降级，绝不向外抛。返回是否持久化成功 */
export function saveCustomCommands(storage: StorageLike, texts: string[]): boolean {
  try {
    storage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(texts));
    return true;
  } catch {
    return false;
  }
}

/** 追加自定义指令（trim、空忽略、去重，返回新列表） */
export function addCustomCommand(texts: string[], text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "" || texts.includes(trimmed)) return texts.slice();
  return [...texts, trimmed];
}

/** 删除自定义指令（返回新列表） */
export function removeCustomCommand(texts: string[], text: string): string[] {
  return texts.filter((t) => t !== text);
}

/** 合并渲染列表：内置在前，自定义在后 */
export function allCommands(custom: string[]): QuickCommand[] {
  const customCmds: QuickCommand[] = custom.map((text) => ({ id: customCommandId(text), text, builtin: false }));
  return [...BUILTIN_COMMANDS, ...customCmds];
}

/** 把模板插入输入框现有文本（可编辑后发送）：非空时换行衔接 */
export function insertSnippet(current: string, snippet: string): string {
  const trimmed = snippet.trim();
  if (trimmed === "") return current;
  const base = current.replace(/\s+$/, "");
  return base === "" ? trimmed : `${base}\n${trimmed}`;
}
