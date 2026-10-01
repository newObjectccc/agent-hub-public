/**
 * Token 用量前端工具（契约 §14）单测：紧凑数字格式化、会话用量索引。
 */
import { describe, expect, it } from "vitest";
import type { SessionUsage } from "../api/types";
import { formatTokens, usageBySession } from "./usage";

describe("formatTokens：紧凑显示", () => {
  it("<1k 原样；k/M 各保留 1-2 位小数并去尾零", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(14_085)).toBe("14.1k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatTokens(2_600_000)).toBe("2.6M");
  });

  it("非法值（NaN/负数/Infinity）安静降级为 0", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("usageBySession：sessions[] → 索引", () => {
  const sessions: SessionUsage[] = [
    {
      sessionId: "s-1",
      name: "pi-demo",
      updatedAt: "2026-02-18T11:58:00.000Z",
      usage: { totalTokens: 162, input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, costTotal: 3 },
    },
    {
      sessionId: "s-2",
      name: null,
      updatedAt: "2026-02-18T10:00:00.000Z",
      usage: { totalTokens: 15, input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 1, costTotal: null },
    },
  ];

  it("按 sessionId 索引全量用量（会话卡片零额外请求）", () => {
    const map = usageBySession(sessions);
    expect(map.get("s-1")?.totalTokens).toBe(162);
    expect(map.get("s-1")?.costTotal).toBe(3);
    expect(map.get("s-2")?.costTotal).toBeNull();
    expect(map.get("nope")).toBeUndefined();
  });

  it("空列表 → 空表（无数据安静降级）", () => {
    expect(usageBySession([]).size).toBe(0);
  });
});
