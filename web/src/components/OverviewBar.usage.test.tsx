/**
 * OverviewBar token 用量展示（契约 §14）单测：
 * 今日概览 token 格（今日 / 近 7 天，紧凑数字）与加载失败降级占位。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardStats, UsageTotals, UsageWindows } from "../api/types";
import { OverviewBar } from "./OverviewBar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeTotals(totalTokens: number): UsageTotals {
  return { totalTokens, input: 1, output: 1, cacheRead: 1, cacheWrite: 0, reasoning: 0, costTotal: null };
}

const usageWindows: UsageWindows = {
  today: makeTotals(14_085),
  last7Days: makeTotals(1_234_567),
  all: makeTotals(2_600_000),
};

const statsFixture: DashboardStats = {
  working: 1,
  needAttention: 2,
  todayDone: 3,
  todayMessages: 24,
  weekCommits: 17,
  streak: 5,
  weekMessages: 96,
  weekDone: 4,
  todayDoneSessions: [],
  workingSessions: [],
  attentionSessions: [],
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("OverviewBar：token 格", () => {
  it("有用量数据：今日 / 7天 tokens 紧凑显示", () => {
    const el = render(<OverviewBar stats={statsFixture} loaded usage={usageWindows} />);
    const text = el.textContent ?? "";
    expect(text).toContain("今日 tokens");
    expect(text).toContain("7天 tokens");
    expect(text).toContain("14.1k");
    expect(text).toContain("1.23M");
    expect(el.querySelectorAll(".overview-chip.off")).toHaveLength(0);
  });

  it("用量加载失败/无数据：token 格安静降级为占位，其它格不受影响", () => {
    const el = render(<OverviewBar stats={statsFixture} loaded usage={null} />);
    const text = el.textContent ?? "";
    expect(text).toContain("今日 tokens");
    expect(text).toContain("7天 tokens");
    expect(text).toContain("今日消息");
    expect(el.querySelectorAll(".overview-chip.off")).toHaveLength(2);
    expect(text).not.toContain("14.1k");
    expect(text).not.toContain("1.23M");
  });

  it("未加载完成：全部格显示占位（含 token 格）", () => {
    const el = render(<OverviewBar stats={null} loaded={false} />);
    expect(el.querySelectorAll(".overview-chip.off")).toHaveLength(6);
  });
});
