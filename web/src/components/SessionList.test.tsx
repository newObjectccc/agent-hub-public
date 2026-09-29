import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import { SessionList, sortSessions } from "./SessionList";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

function makeSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s-1",
    source: "pi",
    name: "pi-demo",
    cwd: "/Users/me/Workspace/demo",
    updatedAt: new Date(NOW - 2 * 60_000).toISOString(),
    messageCount: 4,
    status: "idle",
    lastUserMessage: "帮我检查周报 KPI 口径",
    lastAssistantMessage: "好的，我先查 ETL 水位",
    sessionFile: "/Users/me/.pi/agent/sessions/x.jsonl",
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

describe("SessionList 渲染", () => {
  it("渲染每个会话的 name、cwd、状态徽章、最后对话摘要与相对时间", () => {
    const sessions = [
      makeSession({ id: "a", name: "pi-alpha", status: "running", updatedAt: new Date(NOW - 2 * 60_000).toISOString() }),
      makeSession({
        id: "b",
        name: "pi-beta",
        status: "error",
        cwd: "/Users/me/Workspace/beta",
        lastAssistantMessage: null,
        lastUserMessage: "排查构建失败",
        updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
      }),
    ];
    const el = render(<SessionList sessions={sessions} onSelect={() => {}} now={NOW} />);
    const text = el.textContent ?? "";

    expect(text).toContain("pi-alpha");
    expect(text).toContain("pi-beta");
    expect(text).toContain("~/Workspace/demo"); // 路径缩写显示（完整路径在 title 提示）
    expect(text).toContain("~/Workspace/beta");
    // 状态徽章中文标签
    expect(el.querySelectorAll(".badge.running")).toHaveLength(1);
    expect(el.querySelectorAll(".badge.error")).toHaveLength(1);
    expect(el.querySelectorAll(".badge.idle")).toHaveLength(0);
    // 来源徽章（默认 pi）
    expect(el.querySelectorAll(".badge.source-pi")).toHaveLength(2);
    // 摘要：优先 assistant，缺失时回退 user
    expect(text).toContain("好的，我先查 ETL 水位");
    expect(text).toContain("排查构建失败");
    // 相对时间
    expect(text).toContain("2分钟前");
    expect(text).toContain("3小时前");
  });

  it("按 updatedAt 倒序显示", () => {
    const sessions = [
      makeSession({ id: "old", name: "较旧", updatedAt: new Date(NOW - 60 * 60_000).toISOString() }),
      makeSession({ id: "new", name: "较新", updatedAt: new Date(NOW - 60_000).toISOString() }),
      makeSession({ id: "mid", name: "中间", updatedAt: new Date(NOW - 10 * 60_000).toISOString() }),
    ];
    const el = render(<SessionList sessions={sessions} onSelect={() => {}} now={NOW} />);
    const names = Array.from(el.querySelectorAll(".session-name")).map((n) => n.textContent);
    expect(names).toEqual(["较新", "中间", "较旧"]);
  });

  it("点击会话触发 onSelect 回调", () => {
    const onSelect = vi.fn();
    const session = makeSession({ id: "abc" });
    const el = render(<SessionList sessions={[session]} onSelect={onSelect} now={NOW} />);
    const item = el.querySelector(".session-item") as HTMLButtonElement;
    act(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "abc" }));
  });

  it("claude 会话渲染 claude 来源徽章（与 pi 并列展示）", () => {
    const el = render(
      <SessionList
        sessions={[
          makeSession({ id: "c1", source: "claude", name: "claude 会话" }),
          makeSession({ id: "p1", source: "pi", name: "pi 会话" }),
        ]}
        onSelect={() => {}}
        now={NOW}
      />,
    );
    expect(el.querySelectorAll(".badge.source-claude")).toHaveLength(1);
    expect(el.querySelectorAll(".badge.source-pi")).toHaveLength(1);
    expect(el.textContent).toContain("claude");
  });

  it("lastAssistantMessage 与 lastUserMessage 都为空时显示占位文案", () => {
    const el = render(
      <SessionList
        sessions={[makeSession({ lastAssistantMessage: null, lastUserMessage: null })]}
        onSelect={() => {}}
        now={NOW}
      />,
    );
    expect(el.textContent).toContain("暂无对话内容");
  });
});

describe("sortSessions", () => {
  it("不修改原数组且按 updatedAt 倒序，非法时间排最后", () => {
    const input = [
      makeSession({ id: "1", updatedAt: "invalid" }),
      makeSession({ id: "2", updatedAt: new Date(NOW - 60_000).toISOString() }),
      makeSession({ id: "3", updatedAt: new Date(NOW - 3_600_000).toISOString() }),
    ];
    const snapshot = input.map((s) => s.id);
    const sorted = sortSessions(input);
    expect(sorted.map((s) => s.id)).toEqual(["2", "3", "1"]);
    expect(input.map((s) => s.id)).toEqual(snapshot);
  });
});
