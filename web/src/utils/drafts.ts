/**
 * 输入草稿持久化（UX 审查 AC1）：按 sessionId 存文本草稿到 localStorage。
 * - 只存文本（附件不持久化：附件可能已上传/失效，恢复引用会指向脏文件）
 * - 30 天未动清理（防 localStorage 膨胀）；空文本即时删除不留空壳
 * 纯函数 + Storage 注入，可单测；存储不可用/解析失败一律安全降级（返回 null）。
 */

/** 只依赖 Storage 的 getItem/setItem 子集（removeItem 可选，兼容 recentRefs.safeStorage） */
export type DraftStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

/** 草稿总键（一张表存全部会话：便于统一 30 天过期清理） */
export const DRAFTS_KEY = "agent-hub.chatDrafts.v1";
/** 草稿保鲜期：30 天未动即清理 */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 输入防抖落盘时长（逐键写 localStorage 太频，静默防抖后写） */
export const DRAFT_SAVE_DEBOUNCE_MS = 300;

export interface DraftEntry {
  text: string;
  updatedAt: number;
}

export type DraftTable = Record<string, DraftEntry>;

/** 解析草稿表（损坏/缺省 → 空表，绝不 throw） */
export function parseDraftTable(raw: string | null): DraftTable {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DraftTable = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<DraftEntry> | null;
      if (!entry || typeof entry.text !== "string" || entry.text === "") continue;
      if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) continue;
      out[key] = { text: entry.text, updatedAt: entry.updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

/** 清理过期草稿（updatedAt 距 now 超过 TTL）；返回新表（纯函数） */
export function pruneDraftTable(table: DraftTable, now: number, ttlMs: number = DRAFT_TTL_MS): DraftTable {
  const out: DraftTable = {};
  for (const [key, entry] of Object.entries(table)) {
    if (now - entry.updatedAt <= ttlMs) out[key] = entry;
  }
  return out;
}

/** 读某会话草稿（无/过期/损坏 → null） */
export function loadDraft(storage: DraftStorage | null, sessionId: string, now: number = Date.now()): string | null {
  try {
    const table = parseDraftTable(storage?.getItem(DRAFTS_KEY) ?? null);
    const entry = table[sessionId];
    if (!entry) return null;
    if (now - entry.updatedAt > DRAFT_TTL_MS) return null;
    return entry.text === "" ? null : entry.text;
  } catch {
    return null;
  }
}

/** 写/清草稿（text 为空 → 删除该会话条目）；写入前顺手清理 30 天旧草稿 */
export function saveDraft(storage: DraftStorage | null, sessionId: string, text: string, now: number = Date.now()): void {
  try {
    if (!storage) return;
    const table = pruneDraftTable(parseDraftTable(storage.getItem(DRAFTS_KEY) ?? null), now);
    if (text === "") delete table[sessionId];
    else table[sessionId] = { text, updatedAt: now };
    // 无论如何都落盘（含“全空/全被清”时删键）：否则旧值残留给下次读取
    if (Object.keys(table).length === 0) {
      storage.removeItem?.(DRAFTS_KEY);
      return;
    }
    storage.setItem(DRAFTS_KEY, JSON.stringify(table));
  } catch {
    // 存储不可用/超额：草稿退化为仅本次页面内保留
  }
}

/** 清某会话草稿（发送成功后调用） */
export function clearDraft(storage: DraftStorage | null, sessionId: string): void {
  saveDraft(storage, sessionId, "");
}
