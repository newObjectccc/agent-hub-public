/**
 * 会话树形分组（纯函数为主）：子代理挂到其派生父会话下（文件树式）。
 *
 * 分组依据（server 契约字段）：
 * - `isSubAgent === true` 且 `parentSessionId` 指向列表内主会话 → 归入该父会话的子行；
 * - 识别不出父子（parentSessionId 缺失 / 父不在列表 / 环）→ "未归组子代理"兜底分组
 *   （沿用 R3 的 🤖 折叠分组渲染）。
 * - fork 等非子代理会话即使带 parentSessionId 也不进树（保持主会话平铺排序不变）。
 *
 * 展开/折叠状态 localStorage 持久（`agent-hub.sessions.expanded`，JSON string[]）。
 */
import type { SessionSummary } from "../api/types";

/** 展开状态持久化 key */
export const EXPANDED_STORAGE_KEY = "agent-hub.sessions.expanded";

export interface SessionGroups {
  /** 主会话（排序后的顺序） */
  roots: SessionSummary[];
  /** 父会话 id → 子代理列表（组内保持输入顺序，即 updatedAt desc + id tiebreaker） */
  childrenOf: Map<string, SessionSummary[]>;
  /** 未归组子代理（识别不出父子关系的兜底分组） */
  orphans: SessionSummary[];
}

/** 会话是否可作为树的父节点（只认主会话） */
function isRootSession(s: SessionSummary): boolean {
  return s.isSubAgent !== true;
}

/**
 * 已排序平铺数组 → 树形分组（不排序，顺序沿用输入）。
 * 自引用 / 子代理指向子代理的脏数据一律归 orphans（防环、防错挂）。
 */
export function groupSessions(sessions: readonly SessionSummary[]): SessionGroups {
  const roots: SessionSummary[] = [];
  const childrenOf = new Map<string, SessionSummary[]>();
  const orphans: SessionSummary[] = [];
  const rootIds = new Set<string>();
  for (const s of sessions) {
    if (isRootSession(s)) {
      roots.push(s);
      rootIds.add(s.id);
    }
  }
  for (const s of sessions) {
    if (isRootSession(s)) continue;
    const parentId = s.parentSessionId ?? null;
    if (parentId !== null && parentId !== s.id && rootIds.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(s);
      childrenOf.set(parentId, list);
    } else {
      orphans.push(s);
    }
  }
  return { roots, childrenOf, orphans };
}

/** localStorage 形状（可注入便于测试） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读展开集合（无记录/损坏 → 空集合 = 全部收起） */
export function loadExpanded(storage: StorageLike | null): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(EXPANDED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** 写展开集合（失败静默：持久化只是体验优化） */
export function saveExpanded(storage: StorageLike | null, expanded: ReadonlySet<string>): void {
  if (!storage) return;
  try {
    storage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // 配额满/隐私模式：忽略
  }
}
