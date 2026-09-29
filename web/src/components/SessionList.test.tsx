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
    source: "pi",
    name: "pi-demo",
    cwd: "/Users/me/Workspace/demo",
    updatedAt: new Date(NOW - 2 * 60_000).toISOString(),
    messageCount: 4,
    status: "idle",
    lastUserMessage: "帮我检查周报 KPI 口径",
    lastAssistantMessage: "好的，我先查 ETL 水位",
    sessionFile: "/Users/me/.pi/agent/sessions/x.jsonl",
    isSubAgent: false,
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

  it("主会话整体排前，子代理排后（不抢占主会话优先级），组内仍按 updatedAt 倒序", () => {
    const input = [
      makeSession({ id: "sub-new", isSubAgent: true, updatedAt: new Date(NOW).toISOString() }),
      makeSession({ id: "main-old", updatedAt: new Date(NOW - 3_600_000).toISOString() }),
      makeSession({ id: "sub-old", isSubAgent: true, updatedAt: new Date(NOW - 7_200_000).toISOString() }),
      makeSession({ id: "main-new", updatedAt: new Date(NOW - 60_000).toISOString() }),
    ];
    const sorted = sortSessions(input);
    expect(sorted.map((s) => s.id)).toEqual(["main-new", "main-old", "sub-new", "sub-old"]);
  });
});

describe("SessionList 子代理区分（isSubAgent）", () => {
  const mains = [
    makeSession({ id: "m1", name: "主会话甲", updatedAt: new Date(NOW - 60_000).toISOString() }),
    makeSession({ id: "m2", name: "主会话乙", updatedAt: new Date(NOW - 120_000).toISOString() }),
  ];
  const subs = [
    makeSession({
      id: "s1",
      name: "developer#abc123",
      isSubAgent: true,
      updatedAt: new Date(NOW - 30_000).toISOString(),
    }),
    makeSession({
      id: "s2",
      name: "acceptance-reviewer#f81d33aa",
      isSubAgent: true,
      updatedAt: new Date(NOW - 90_000).toISOString(),
    }),
  ];

  it("子代理默认收起：折叠分组显示数量，子代理行不渲染，主会话正常渲染", () => {
    const el = render(<SessionList sessions={[...mains, ...subs]} onSelect={() => {}} now={NOW} />);
    const text = el.textContent ?? "";
    expect(text).toContain("子代理 (2)");
    expect(text).toContain("主会话甲");
    expect(text).toContain("主会话乙");
    expect(text).not.toContain("developer#abc123");
    expect(el.querySelector(".subagent-toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("展开分组后子代理会话显示 🤖 子代理 徽章，再点收起", () => {
    const el = render(<SessionList sessions={[...mains, ...subs]} onSelect={() => {}} now={NOW} />);
    const toggle = el.querySelector(".subagent-toggle") as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = el.textContent ?? "";
    expect(el.querySelector(".subagent-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(text).toContain("developer#abc123");
    expect(text).toContain("acceptance-reviewer#f81d33aa");
    expect(el.querySelectorAll(".badge.subagent")).toHaveLength(2);
    // 主会话不带子代理徽章
    expect(text).toContain("主会话甲");
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("developer#abc123");
  });

  it("无子代理会话时不渲染折叠分组", () => {
    const el = render(<SessionList sessions={mains} onSelect={() => {}} now={NOW} />);
    expect(el.querySelector(".subagent-toggle")).toBeNull();
  });

  it("点击子代理行触发 onSelect（分组内行与主列表行为一致）", () => {
    const onSelect = vi.fn();
    const el = render(<SessionList sessions={[...mains, ...subs]} onSelect={onSelect} now={NOW} />);
    act(() => {
      (el.querySelector(".subagent-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const rows = el.querySelectorAll(".subagent-list .session-item");
    act(() => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });
});
