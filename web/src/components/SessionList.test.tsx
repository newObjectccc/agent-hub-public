import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import { SessionList, SESSION_ITEM_HEIGHT, sortSessions } from "./SessionList";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

function makeSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s-1",
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

describe("SessionList 虚拟滚动（几百会话流畅）", () => {
  function makeMany(count: number): SessionSummary[] {
    return Array.from({ length: count }, (_, i) =>
      makeSession({ id: `s${i}`, name: `会话 ${i}`, updatedAt: new Date(NOW - i * 60_000).toISOString() }),
    );
  }

  it("300 条会话只渲染视口附近的行（DOM 节点数恒定）", () => {
    const el = render(<SessionList sessions={makeMany(300)} onSelect={() => {}} now={NOW} viewportHeight={600} />);
    const rendered = el.querySelectorAll(".session-item");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(20); // 远小于 300
    // 上下占位撑起总高度，滚动条位置稳定
    const inner = el.querySelector(".session-list") as HTMLElement;
    expect(inner.style.paddingBottom).not.toBe("");
  });

  it("滚动后窗口平移渲染其它行", () => {
    const el = render(<SessionList sessions={makeMany(300)} onSelect={() => {}} now={NOW} viewportHeight={600} />);
    const scroller = el.querySelector(".virtual-scroll") as HTMLElement;
    const before = Array.from(el.querySelectorAll(".session-name")).map((n) => n.textContent);
    act(() => {
      scroller.scrollTop = SESSION_ITEM_HEIGHT * 100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    const after = Array.from(el.querySelectorAll(".session-name")).map((n) => n.textContent);
    expect(after).not.toEqual(before);
    expect(after[0]).toContain("会话 ");
    expect(el.querySelectorAll(".session-item").length).toBeLessThan(20);
  });

  it("列表 scrollTop 记忆：initialScrollTop 恢复滚动位置", () => {
    const el = render(
      <SessionList sessions={makeMany(300)} onSelect={() => {}} now={NOW} viewportHeight={600} initialScrollTop={SESSION_ITEM_HEIGHT * 40} />,
    );
    const scroller = el.querySelector(".virtual-scroll") as HTMLElement;
    expect(scroller.scrollTop).toBe(SESSION_ITEM_HEIGHT * 40);
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
