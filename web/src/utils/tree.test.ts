/**
 * 分支树渲染行单测：深度、活跃分支标记、折叠隐藏子树、先序 DFS 顺序、孤儿根。
 */
import { describe, expect, it } from "vitest";
import type { TreeNode } from "../api/types";
import { treeRows } from "./tree";

function node(id: string, parentId: string | null, hasChildren: boolean): TreeNode {
  return { id, parentId, role: "user", text: id, timestamp: 0, hasChildren };
}

/** 分叉 fixture：e1 → e2 → e3（弃用），e1 → e4 → e5（活跃） */
const forked: TreeNode[] = [
  node("e1", null, true),
  node("e2", "e1", true),
  node("e3", "e2", false),
  node("e4", "e1", true),
  node("e5", "e4", false),
];
const activePath = ["e1", "e4", "e5"];

describe("treeRows 分支树渲染行", () => {
  it("先序 DFS + 深度：根 0，逐层 +1", () => {
    const rows = treeRows(forked, activePath, new Set());
    expect(rows.map((r) => r.node.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 2]);
  });

  it("活跃分支标记（activePath 上的节点），弃用分支不标", () => {
    const rows = treeRows(forked, activePath, new Set());
    expect(rows.map((r) => r.onActivePath)).toEqual([true, false, false, true, true]);
  });

  it("折叠节点隐藏整棵子树，展开恢复；expandable 跟随 hasChildren", () => {
    const rows = treeRows(forked, activePath, new Set(["e2"]));
    expect(rows.map((r) => r.node.id)).toEqual(["e1", "e2", "e4", "e5"]);
    expect(rows.map((r) => r.expandable)).toEqual([true, true, true, false]);
    // 同时折叠 e2/e4：只剩这两个节点自身；折叠 e1 则整棵子树只剩根
    const both = treeRows(forked, activePath, new Set(["e2", "e4"]));
    expect(both.map((r) => r.node.id)).toEqual(["e1", "e2", "e4"]);
    const all = treeRows(forked, activePath, new Set(["e1"]));
    expect(all.map((r) => r.node.id)).toEqual(["e1"]);
  });

  it("悬空 parentId 的节点按根处理（depth 0），不丢行", () => {
    const rows = treeRows([...forked, node("x1", "missing", false)], activePath, new Set());
    const x1 = rows.find((r) => r.node.id === "x1");
    expect(x1?.depth).toBe(0);
    expect(rows).toHaveLength(6);
  });

  it("空输入返回空数组", () => {
    expect(treeRows([], [], new Set())).toEqual([]);
  });
});
