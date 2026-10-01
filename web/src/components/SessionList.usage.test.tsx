/**
 * SessionList 行内 token 用量徽章（契约 §14）单测：
 * 有数据显示紧凑 tokens、无数据安静隐藏、加载失败不渲染徽章。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary, UsageTotals } from "../api/types";
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
