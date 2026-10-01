/**
 * Token 用量展示组件（契约 §14）单测：
 * 今日概览 token 格（今日 / 近 7 天，紧凑数字）与加载失败降级占位；
 * 会话列表行内 token 徽章（有数据显示、无数据安静隐藏）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardStats, SessionSummary, UsageTotals, UsageWindows } from "../api/types";
import { OverviewBar } from "./OverviewBar";
import { SessionList } from "./SessionList";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

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

function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s-1",
    source: "pi",
    name: "pi-demo",
    cwd: "/Users/me/Workspace/demo",
    updatedAt: new Date(NOW - 60_000).toISOString(),
    messageCount: 2,
    status: "idle",
    isSubAgent: false,
    lastUserMessage: "跑一下用量统计",
    lastAssistantMessage: "好的",
    sessionFile: "/tmp/s1.jsonl",
    ...over,
  };
}

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

describe("SessionList：行内 token 徽章", () => {
  it("有用量的会话显示紧凑 tokens，无用量的会话安静隐藏", () => {
    const sessions = [makeSession({ id: "a", name: "pi-alpha" }), makeSession({ id: "b", name: "pi-beta" })];
    const el = render(
      <SessionList
        sessions={sessions}
        onSelect={() => {}}
        now={NOW}
        usageBySession={new Map([["a", makeTotals(2_600_000)]])}
      />,
    );
    const badges = el.querySelectorAll(".session-tokens");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("2.6M");
  });

  it("无用量索引（加载失败）：所有行不渲染 token 徽章", () => {
    const el = render(<SessionList sessions={[makeSession()]} onSelect={() => {}} now={NOW} />);
    expect(el.querySelectorAll(".session-tokens")).toHaveLength(0);
  });

  it("totalTokens=0 视为无数据，不渲染徽章", () => {
    const el = render(
      <SessionList
        sessions={[makeSession({ id: "a" })]}
        onSelect={() => {}}
        now={NOW}
        usageBySession={new Map([["a", makeTotals(0)]])}
      />,
    );
    expect(el.querySelectorAll(".session-tokens")).toHaveLength(0);
  });
});
