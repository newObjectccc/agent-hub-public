/**
 * 最近引用文件（@ 面板"最近引用"快捷区，localStorage 持久化）。
 * 存储与合并逻辑为纯函数，便于单测；UI 只做渲染。
 * （storage 存取沿用原快捷指令的 StorageLike/safeStorage 模式。）
 */

export const RECENT_REFS_STORAGE_KEY = "agent-hub.recentFileRefs.v1";
/** 最近引用上限 */
export const RECENT_REFS_LIMIT = 8;

/** 只依赖 Storage 的 getItem/setItem 子集，测试可注入 fake */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

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

/** 读最近引用（存储损坏/缺省 → 空列表） */
export function loadRecentRefs(storage: StorageLike): string[] {
  try {
    const raw = storage.getItem(RECENT_REFS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .map((t) => t.trim())
      .slice(0, RECENT_REFS_LIMIT);
  } catch {
    return [];
  }
}

/** 保存最近引用：任何异常（quota/隐私模式）静默降级，绝不向外抛 */
export function saveRecentRefs(storage: StorageLike, refs: string[]): boolean {
  try {
    storage.setItem(RECENT_REFS_STORAGE_KEY, JSON.stringify(refs.slice(0, RECENT_REFS_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** 追加一条引用（去重、最新在前、限长） */
export function addRecentRef(refs: string[], ref: string): string[] {
  const trimmed = ref.trim();
  if (trimmed === "") return refs.slice();
  return [trimmed, ...refs.filter((t) => t !== trimmed)].slice(0, RECENT_REFS_LIMIT);
}
