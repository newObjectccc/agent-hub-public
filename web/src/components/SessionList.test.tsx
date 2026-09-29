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

  it("优先级：等你处理 > 工作中 > 其他，组内 updatedAt 倒序 + id tiebreaker", () => {
    const iso = (offsetMin: number) => new Date(NOW - offsetMin * 60_000).toISOString();
    const input = [
      makeSession({ id: "other-new", status: "idle", updatedAt: iso(1) }),
      makeSession({ id: "run-old", status: "running", updatedAt: iso(30) }),
      makeSession({ id: "attn-old", status: "idle", updatedAt: iso(60) }),
      makeSession({ id: "run-new", status: "running", updatedAt: iso(5) }),
      makeSession({ id: "attn-new", status: "error", updatedAt: iso(10) }),
      makeSession({ id: "other-old", status: "idle", updatedAt: iso(90) }),
    ];
    const attentionIds = new Set(["attn-old", "attn-new"]);
    const sorted = sortSessions(input, {
      attentionIds,
      isRunning: (s) => s.status === "running",
    });
    // 等你处理组（组内时间倒序）→ 工作中组 → 其他组
    expect(sorted.map((s) => s.id)).toEqual([
      "attn-new",
      "attn-old",
      "run-new",
      "run-old",
      "other-new",
      "other-old",
    ]);
    // 同优先级同时间：id 升序 tiebreaker（与旧逻辑一致）
    const tie = [
      makeSession({ id: "b", status: "idle", updatedAt: iso(5) }),
      makeSession({ id: "a", status: "idle", updatedAt: iso(5) }),
    ];
    expect(
      sortSessions(tie, { attentionIds, isRunning: (s) => s.status === "running" }).map((s) => s.id),
    ).toEqual(["a", "b"]);
  });

  it("不传 priority 时保持纯 updatedAt 倒序（running 不提前）", () => {
    const iso = (offsetMin: number) => new Date(NOW - offsetMin * 60_000).toISOString();
    const input = [
      makeSession({ id: "running-old", status: "running", updatedAt: iso(30) }),
      makeSession({ id: "idle-new", status: "idle", updatedAt: iso(1) }),
    ];
    expect(sortSessions(input).map((s) => s.id)).toEqual(["idle-new", "running-old"]);
  });
});

describe("SessionList 行内已运行标记与优先级渲染", () => {
  it("运行中会话行内显示「已运行 X 分钟」实时标记（注入起点时）", () => {
    const sessions = [
      makeSession({ id: "r1", name: "运行中会话", status: "running", updatedAt: new Date(NOW - 60_000).toISOString() }),
      makeSession({ id: "i1", name: "空闲会话", status: "idle", updatedAt: new Date(NOW - 2 * 60_000).toISOString() }),
    ];
    const runningSince = new Map([["r1", NOW - 30 * 60_000]]);
    const el = render(
      <SessionList sessions={sessions} onSelect={() => {}} now={NOW} runningSince={runningSince} />,
    );
    // 实时标记（替代原进度卡关键信息），只标运行中且有起点的行
    expect(el.querySelectorAll(".session-elapsed")).toHaveLength(1);
    expect(el.textContent).toContain("已运行 30分钟");
    // 相对时间不减（语义不减）
    expect(el.textContent).toContain("2分钟前");
  });

  it("注入 priority 后列表按 等你处理 > 工作中 > 其他 渲染", () => {
    const iso = (offsetMin: number) => new Date(NOW - offsetMin * 60_000).toISOString();
    const sessions = [
      makeSession({ id: "o", name: "其他会话", status: "idle", updatedAt: iso(1) }),
      makeSession({ id: "r", name: "工作中会话", status: "running", updatedAt: iso(2) }),
      makeSession({ id: "a", name: "等你处理会话", status: "idle", updatedAt: iso(3) }),
    ];
    const el = render(
      <SessionList
        sessions={sessions}
        onSelect={() => {}}
        now={NOW}
        priority={{ attentionIds: new Set(["a"]), isRunning: (s) => s.status === "running" }}
      />,
    );
    const names = Array.from(el.querySelectorAll(".session-name")).map((n) => n.textContent);
    expect(names).toEqual(["等你处理会话", "工作中会话", "其他会话"]);
  });
});
