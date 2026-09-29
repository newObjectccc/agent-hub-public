/**
 * 会话树形分组单测：子代理挂父会话（parentSessionId）/ 未归组兜底 / 防环 /
 * 展开状态 localStorage 持久。
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/types";
import { EXPANDED_STORAGE_KEY, groupSessions, loadExpanded, saveExpanded } from "./sessionTree";

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

function makeSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s-1",
    source: "pi",
    name: "pi-demo",
    cwd: "/Users/me/Workspace/demo",
    updatedAt: new Date(NOW).toISOString(),
    messageCount: 1,
    status: "idle",
    isSubAgent: false,
    lastUserMessage: null,
    lastAssistantMessage: null,
    sessionFile: "/tmp/x.jsonl",
    ...over,
  };
}

describe("groupSessions：子代理树形分组", () => {
  it("parentSessionId 命中列表内主会话 → 归入其子行（保持输入顺序）", () => {
    const parent = makeSession({ id: "p1" });
    const sub1 = makeSession({ id: "c1", isSubAgent: true, parentSessionId: "p1", name: "developer#aaa111" });
    const sub2 = makeSession({ id: "c2", isSubAgent: true, parentSessionId: "p1", name: "developer#bbb222" });
    const groups = groupSessions([parent, sub1, sub2]);
    expect(groups.roots.map((s) => s.id)).toEqual(["p1"]);
    expect(groups.childrenOf.get("p1")?.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(groups.orphans).toEqual([]);
  });

  it("识别不出父子 → 未归组兜底（parentId 缺失 / 父不在列表）", () => {
    const subNoParent = makeSession({ id: "o1", isSubAgent: true, parentSessionId: null });
    const subMissingParent = makeSession({ id: "o2", isSubAgent: true, parentSessionId: "not-here" });
    const groups = groupSessions([subNoParent, subMissingParent]);
    expect(groups.roots).toEqual([]);
    expect(groups.orphans.map((s) => s.id)).toEqual(["o1", "o2"]);
  });

  it("fork 等非子代理会话带 parentSessionId 不进树（主会话平铺不变）", () => {
    const parent = makeSession({ id: "p1" });
    const fork = makeSession({ id: "f1", parentSessionId: "p1" });
    const groups = groupSessions([parent, fork]);
    expect(groups.roots.map((s) => s.id)).toEqual(["p1", "f1"]);
    expect(groups.childrenOf.size).toBe(0);
    expect(groups.orphans).toEqual([]);
  });

  it("防环：自引用 / 子代理指向子代理 → 归 orphans，不进树", () => {
    const selfRef = makeSession({ id: "c0", isSubAgent: true, parentSessionId: "c0" });
    const subA = makeSession({ id: "ca", isSubAgent: true, parentSessionId: null });
    const subB = makeSession({ id: "cb", isSubAgent: true, parentSessionId: "ca" });
    const groups = groupSessions([selfRef, subA, subB]);
    expect(groups.childrenOf.size).toBe(0);
    expect(groups.orphans.map((s) => s.id)).toEqual(["c0", "ca", "cb"]);
  });
});

describe("展开状态持久化（localStorage）", () => {
  function fakeStorage(): { data: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  }

  it("save → load 往返保持集合内容", () => {
    const storage = fakeStorage();
    saveExpanded(storage, new Set(["p1", "p2"]));
    expect(loadExpanded(storage)).toEqual(new Set(["p1", "p2"]));
  });

  it("无记录 / 损坏 JSON / 非数组 → 空集合（全部收起），不抛错", () => {
    const storage = fakeStorage();
    expect(loadExpanded(storage)).toEqual(new Set());
    storage.setItem(EXPANDED_STORAGE_KEY, "{broken");
    expect(loadExpanded(storage)).toEqual(new Set());
    storage.setItem(EXPANDED_STORAGE_KEY, '{"a":1}');
    expect(loadExpanded(storage)).toEqual(new Set());
    expect(loadExpanded(null)).toEqual(new Set());
  });

  it("过滤数组中的非字符串项", () => {
    const storage = fakeStorage();
    storage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(["a", 1, null, "b"]));
    expect(loadExpanded(storage)).toEqual(new Set(["a", "b"]));
  });
});
