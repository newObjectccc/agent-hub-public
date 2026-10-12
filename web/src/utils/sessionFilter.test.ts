/**
 * 来源筛选纯逻辑测试：空集=全部、多选=并集、计数口径。
 * 与 tab 过滤正交（filterSessionsBySource(filterSessionsByTab(...)) 可叠加）。
 */
import { describe, expect, it } from "vitest";
import { countableSessions, filterSessionsBySource, sourceCounts, SOURCE_OPTIONS } from "./sessionFilter";

const s = (id: string, source: string) => ({ id, source });

describe("filterSessionsBySource", () => {
  const list = [s("a", "pi"), s("b", "claude"), s("c", "codex"), s("d", "pi")];

  it("空集合 = 不筛选", () => {
    expect(filterSessionsBySource(list, new Set())).toEqual(list);
  });

  it("单选 = 命中者", () => {
    expect(filterSessionsBySource(list, new Set(["pi"])).map((x) => x.id)).toEqual(["a", "d"]);
  });

  it("多选 = 并集（保持原顺序）", () => {
    expect(filterSessionsBySource(list, new Set(["codex", "pi"])).map((x) => x.id)).toEqual(["a", "c", "d"]);
  });

  it("source 缺失/null 的会话只在不过滤时出现", () => {
    const withNull = [s("x", ""), { id: "y", source: null }, s("z", "pi")];
    expect(filterSessionsBySource(withNull, new Set()).length).toBe(3);
    expect(filterSessionsBySource(withNull, new Set(["pi"])).map((x) => x.id)).toEqual(["z"]);
  });
});

describe("sourceCounts", () => {
  it("按来源计数（筛选 chips 的决策依据）", () => {
    const counts = sourceCounts([s("a", "pi"), s("b", "pi"), s("c", "codex")]);
    expect(counts).toEqual({ pi: 2, codex: 1 });
  });
});

describe("SOURCE_OPTIONS", () => {
  it("覆盖 pi / claude / codex 三个来源", () => {
    expect(SOURCE_OPTIONS.map((o) => o.value)).toEqual(["pi", "claude", "codex"]);
  });
});

describe("countableSessions（tab 计数口径：不含子代理）", () => {
  it("子代理挂树下展示不计数；主会话/无标记会话计入", () => {
    const list = [
      { id: "a", isSubAgent: false },
      { id: "b", isSubAgent: true },
      { id: "c" },
      { id: "d", isSubAgent: true },
    ];
    expect(countableSessions(list).map((x) => x.id)).toEqual(["a", "c"]);
  });
});
