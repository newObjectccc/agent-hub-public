/**
 * 分支树渲染的纯函数（可单测）：
 * server 返回先序 DFS 的扁平 entries，这里补 depth/可见性/活跃分支标记，
 * 供 TreePage 折叠展开与缩进连线渲染。
 */
import type { TreeNode } from "../api/types";

export interface TreeRow {
  node: TreeNode;
  /** 根=0，逐层 +1 */
  depth: number;
  /** 在活跃分支（activePath）上 */
  onActivePath: boolean;
  /** 有子节点（可折叠/展开） */
  expandable: boolean;
}

/**
 * 扁平化为渲染行（先序 DFS，保持 server 顺序）。
 * collapsed 中的节点子树整体隐藏；悬空 parentId 的节点按根处理（与 server 一致）。
 */
export function treeRows(entries: TreeNode[], activePath: string[], collapsed: ReadonlySet<string>): TreeRow[] {
  const byId = new Map<string, TreeNode>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const parent = entry.parentId !== null ? byId.get(entry.parentId) : undefined;
    if (!parent || parent.id === entry.id) {
      roots.push(entry);
      continue;
    }
    const bucket = children.get(parent.id) ?? [];
    bucket.push(entry);
    children.set(parent.id, bucket);
  }

  const active = new Set(activePath);
  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const walk = (node: TreeNode, depth: number, visible: boolean): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (visible) {
      rows.push({
        node,
        depth,
        onActivePath: active.has(node.id),
        expandable: node.hasChildren,
      });
    }
    // 折叠时仍下钻标记 visited（隐藏节点不能被孤儿兑底逻辑重新显示），但不产出行
    const childVisible = visible && !collapsed.has(node.id);
    for (const kid of children.get(node.id) ?? []) walk(kid, depth + 1, childVisible);
  };
  for (const root of roots) walk(root, 0, true);
  // 环内未到达的节点兜底展开，保证不丢数据
  for (const entry of entries) {
    if (!visited.has(entry.id)) walk(entry, 0, true);
  }
  return rows;
}
