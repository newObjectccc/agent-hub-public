/**
 * 工作台首页分源展示（v0.3）：今日概览卡片组的来源细分小字（pi · claude · codex）、
 * 「🔥工作中」/「⚠️等你处理」来源过滤 chips（含计数）与卡片来源徽章。
 * mock bySource 数据断言细分数字真实渲染，移动端轻量过滤行为可点。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionSessionCard, DashboardStats, WorkingSessionCard } from "../api/types";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getDashboardStats: mocks.getDashboardStats,
    getUsage: mocks.getUsage,
  },
}));

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: () => undefined,
}));

import { HomePage } from "./HomePage";

function working(id: string, name: string, source: WorkingSessionCard["source"]): WorkingSessionCard {
  return {
    id,
    name,
    cwd: "/tmp/w",
    status: "running",
    source,
    startedAt: "2026-02-18T10:00:00.000Z",
    currentTool: null,
    lastOutput: null,
    updatedAt: "2026-02-18T11:00:00.000Z",
  };
}

function attention(id: string, name: string, source: AttentionSessionCard["source"]): AttentionSessionCard {
  return {
    id,
    name,
    cwd: "/tmp/a",
    status: "idle",
    source,
    reason: "settled",
    summary: null,
    updatedAt: "2026-02-18T11:00:00.000Z",
  };
}

const statsFixture: DashboardStats = {
  working: 3,
  needAttention: 2,
  todayDone: 6,
  todayMessages: 60,
  weekCommits: 0,
  streak: 1,
  weekMessages: 60,
  weekDone: 3,
  todayDoneSessions: [],
  workingSessions: [
    working("w-pi", "pi 跑测试", "pi"),
    working("w-claude", "claude 写文档", "claude"),
    working("w-codex", "codex 修 bug", "codex"),
  ],
  attentionSessions: [
    attention("a-claude", "claude 周报", "claude"),
    attention("a-codex", "codex 重构", "codex"),
  ],
  bySource: {
    todayMessages: { pi: 30, claude: 20, codex: 10 },
    todayDone: { pi: 3, claude: 2, codex: 1 },
    working: { pi: 1, claude: 1, codex: 1 },
    needAttention: { pi: 0, claude: 1, codex: 1 },
  },
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<HomePage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  mocks.getDashboardStats.mockReset();
  mocks.getUsage.mockReset();
  mocks.getUsage.mockResolvedValue({ windows: null });
  mocks.getDashboardStats.mockResolvedValue(statsFixture);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("HomePage 分源细分（今日概览小字）", () => {
  it("今日消息/今日完成/工作中渲染 pi · claude · codex 细分数字", async () => {
    const el = await render();
    const text = el.textContent ?? "";
    // 今日消息 30/20/10、今日完成 3/2/1、工作中 1/1/1 三格各自细分
    expect(text).toContain("pi 30 · claude 20 · codex 10");
    expect(text).toContain("pi 3 · claude 2 · codex 1");
    // 细分小字在概览卡内（野兽派紧凑排版，独立 class 可定位）
    const breakdowns = el.querySelectorAll(".overview-breakdown");
    expect(breakdowns.length).toBe(3);
  });

  it("bySource 缺失（老 server）不渲染细分也不崩", async () => {
    mocks.getDashboardStats.mockResolvedValue({
      workingSessions: [],
      attentionSessions: [],
    });
    const el = await render();
    expect(el.querySelectorAll(".overview-breakdown")).toHaveLength(0);
    expect(el.querySelectorAll(".source-breakdown")).toHaveLength(0);
    expect(el.querySelector(".error-banner")).toBeNull();
  });
});

describe("HomePage 来源过滤 chips（工作中 / 等你处理）", () => {
  it("chips 显示各来源计数（needAttention 的 pi 0 也显示）", async () => {
    const el = await render();
    const workGroup = el.querySelector('[aria-label="工作中会话按来源过滤"]')!;
    expect(workGroup.textContent).toContain("pi 1");
    expect(workGroup.textContent).toContain("claude 1");
    expect(workGroup.textContent).toContain("Codex 1");
    const attGroup = el.querySelector('[aria-label="等你处理会话按来源过滤"]')!;
    expect(attGroup.textContent).toContain("pi 0");
    expect(attGroup.textContent).toContain("claude 1");
    expect(attGroup.textContent).toContain("Codex 1");
  });

  it("点「claude」chip → 工作中列表只剩 claude 会话；点「全部」恢复", async () => {
    const el = await render();
    const workGroup = el.querySelector('[aria-label="工作中会话按来源过滤"]')!;
    const claudeChip = Array.from(workGroup.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("claude"))!;
    await act(async () => {
      claudeChip.click();
      await Promise.resolve();
    });
    // 只剩 claude 卡（pi/codex 卡被过滤掉）
    expect(el.textContent).toContain("claude 写文档");
    expect(el.textContent).not.toContain("pi 跑测试");
    expect(el.textContent).not.toContain("codex 修 bug");
    // 等你处理组不受影响（独立过滤状态）
    expect(el.textContent).toContain("claude 周报");
    expect(el.textContent).toContain("codex 重构");

    const allChip = Array.from(workGroup.querySelectorAll("button")).find((b) => b.textContent?.trim() === "全部")!;
    await act(async () => {
      allChip.click();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("pi 跑测试");
    expect(el.textContent).toContain("codex 修 bug");
  });

  it("等你处理组按来源过滤（pi 0 → 空态文案）", async () => {
    const el = await render();
    const attGroup = el.querySelector('[aria-label="等你处理会话按来源过滤"]')!;
    const piChip = Array.from(attGroup.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("pi"))!;
    await act(async () => {
      piChip.click();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("该来源没有等你处理的会话");
    // 工作中组不受影响
    expect(el.textContent).toContain("pi 跑测试");
  });

  it("会话卡片带来源徽章（.badge.source-*）", async () => {
    const el = await render();
    expect(el.querySelectorAll(".badge.source-pi").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".badge.source-claude").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".badge.source-codex").length).toBeGreaterThan(0);
  });
});
