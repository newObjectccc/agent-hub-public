/**
 * tab 过滤 + 进场动画一次性（useFirstSeen 纯决策）+ 排序稳定性单测。
 * 对应用户硬要求：刷新不重排、动画只播一次、tab 切换即时无闪烁。
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/types";
import { computeNewIds } from "../hooks/useFirstSeen";
import { filterSessionsByTab, SESSION_TABS, type SessionTab } from "./sessionTabs";
import { sortSessions } from "../components/SessionList";

function makeSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s-1",
    name: "pi-demo",
    cwd: "/Users/me/Workspace/demo",
    updatedAt: "2026-02-18T12:00:00.000Z",
    messageCount: 1,
    status: "idle",
    lastUserMessage: "hi",
    lastAssistantMessage: "ok",
    sessionFile: "/tmp/s.jsonl",
    ...over,
  };
}

const SESSIONS: SessionSummary[] = [
  makeSession({ id: "a", status: "running", updatedAt: "2026-02-18T11:00:00.000Z" }),
  makeSession({ id: "b", status: "idle", updatedAt: "2026-02-18T10:00:00.000Z" }),
  makeSession({ id: "c", status: "error", updatedAt: "2026-02-18T09:00:00.000Z" }),
  makeSession({ id: "d", status: "idle", updatedAt: "2026-02-18T08:00:00.000Z" }),
];

const IDS = { attentionIds: new Set(["b", "c"]), doneIds: new Set(["d", "a"]) };

describe("sessionTabs: tab 过滤（纯函数，保持输入顺序）", () => {
  it("tab 配置完整：全部/工作中/等你处理/今日完成", () => {
    expect(SESSION_TABS.map((t) => t.value)).toEqual(["all", "working", "attention", "done"]);
    expect(SESSION_TABS.every((t) => t.label.trim() !== "")).toBe(true);
  });

  it("all 原样返回；working 只留 running", () => {
    expect(filterSessionsByTab(SESSIONS, "all", IDS).map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterSessionsByTab(SESSIONS, "working", IDS).map((s) => s.id)).toEqual(["a"]);
  });

  it("attention/done 按 stats 的 id 集合过滤", () => {
    expect(filterSessionsByTab(SESSIONS, "attention", IDS).map((s) => s.id)).toEqual(["b", "c"]);
    expect(filterSessionsByTab(SESSIONS, "done", IDS).map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("空集合 → 空列表（不报错）", () => {
    const empty = { attentionIds: new Set<string>(), doneIds: new Set<string>() };
    for (const tab of ["working", "attention", "done"] as SessionTab[]) {
      expect(Array.isArray(filterSessionsByTab(SESSIONS, tab, empty))).toBe(true);
    }
    expect(filterSessionsByTab(SESSIONS, "attention", empty)).toEqual([]);
  });
});

describe("排序稳定性：固定 updatedAt 倒序，同数据刷新不重排", () => {
  it("两次排序结果完全一致（含相同 updatedAt：id 升序确定性 tiebreaker）", () => {
    const dup = [
      makeSession({ id: "x", updatedAt: "2026-02-18T10:00:00.000Z" }),
      makeSession({ id: "y", updatedAt: "2026-02-18T10:00:00.000Z" }),
      makeSession({ id: "z", updatedAt: "2026-02-18T11:00:00.000Z" }),
    ];
    const first = sortSessions(dup).map((s) => s.id);
    const second = sortSessions([...dup]).map((s) => s.id);
    const third = sortSessions([...dup].reverse()).map((s) => s.id);
    expect(first).toEqual(["z", "x", "y"]);
    expect(second).toEqual(first);
    // 输入顺序翻转也不重排：同一数据永远同一顺序
    expect(third).toEqual(first);
  });

  it("非法时间排最后", () => {
    const mixed = [
      makeSession({ id: "bad", updatedAt: "not-a-date" }),
      makeSession({ id: "ok", updatedAt: "2026-02-18T10:00:00.000Z" }),
    ];
    expect(sortSessions(mixed).map((s) => s.id)).toEqual(["ok", "bad"]);
  });
});

describe("computeNewIds: 进场动画只播一次", () => {
  it("首次出现的 id 标记为新", () => {
    const newIds = computeNewIds(new Set(), ["a", "b"]);
    expect([...newIds].sort()).toEqual(["a", "b"]);
  });

  it("刷新/重渲染同一数据 → 零新条目（零动画）", () => {
    const seen = new Set(["a", "b"]);
    expect(computeNewIds(seen, ["a", "b"]).size).toBe(0);
    expect(computeNewIds(seen, ["a", "b"]).size).toBe(0); // 连续多次刷新
  });

  it("只有增量 id 被标记；同一 id 在批内去重", () => {
    const seen = new Set(["a"]);
    expect([...computeNewIds(seen, ["a", "b", "b", "c"])]).toEqual(["b", "c"]);
  });

  it("见过的 id 移出再回来不重播（tab 切换场景）", () => {
    const seen = new Set<string>();
    const first = computeNewIds(seen, ["a", "b"]);
    expect(first.size).toBe(2);
    for (const id of first) seen.add(id);
    // tab 切换：列表子集变化
    expect(computeNewIds(seen, ["a"]).size).toBe(0);
    // 切回后重新出现也不重播
    expect(computeNewIds(seen, ["a", "b"]).size).toBe(0);
  });

  it("纯函数：不修改入参 seen", () => {
    const seen = new Set(["a"]);
    computeNewIds(seen, ["a", "b"]);
    expect([...seen]).toEqual(["a"]);
  });
});
