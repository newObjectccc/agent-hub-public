/**
 * 工作台组件测试：运行看板卡 / 等你处理卡 / tab 分段组 / 状态徽章闪烁 / 通知中心。
 * 覆盖用户硬要求的行为面：进场动画一次性（.enter 只给新条目）、状态徽章 150ms 闪烁、
 * tab 即时切换、未读角标与全部已读。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionSessionCard, NotificationItem, WorkingSessionCard } from "../api/types";
import { AttentionList } from "./AttentionList";
import { NotificationCenter } from "./NotificationCenter";
import { SessionTabs } from "./SessionTabs";
import { StatusBadge } from "./StatusBadge";
import { WorkingBoard, WorkingCard } from "./WorkingBoard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

function makeWorking(over: Partial<WorkingSessionCard> = {}): WorkingSessionCard {
  return {
    id: "w-1",
    name: "pi-构建修复",
    cwd: "/Users/me/Workspace/demo",
    status: "running",
    startedAt: new Date(NOW - 3_600_000).toISOString(),
    currentTool: "bash: pnpm test",
    lastOutput: "测试全绿",
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function makeAttention(over: Partial<AttentionSessionCard> = {}): AttentionSessionCard {
  return {
    id: "a-1",
    name: "pi-周报",
    cwd: "/Users/me/Workspace/demo",
    status: "idle",
    reason: "settled",
    summary: "已完成，等你确认",
    updatedAt: new Date(NOW - 120_000).toISOString(),
    ...over,
  };
}

function makeNotification(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n-1",
    sessionId: "s-1",
    sessionName: "pi-周报",
    kind: "settled",
    text: "已完成，等你确认",
    timestamp: new Date(NOW - 60_000).toISOString(),
    read: false,
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

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("WorkingBoard 运行看板卡", () => {
  it("渲染会话名、当前工具、已运行时长、最后输出；点击进入", () => {
    const onSelect = vi.fn();
    const el = render(<WorkingCard card={makeWorking()} onSelect={onSelect} now={NOW} />);
    const text = el.textContent ?? "";
    expect(text).toContain("pi-构建修复");
    expect(text).toContain("bash: pnpm test");
    expect(text).toContain("已运行 1时00分");
    expect(text).toContain("测试全绿");
    act(() => {
      (el.querySelector(".working-card") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith("w-1");
  });

  it("进场动画一次性：首渲染有 .enter，数据刷新重渲染后消失（零动画）", () => {
    const one = [makeWorking()];
    const el = render(<WorkingBoard sessions={one} onSelect={() => {}} />);
    expect(el.querySelectorAll(".session-item.enter").length).toBe(1);
    // 同数据刷新（内容微调，id 不变）→ 零动画
    rerender(<WorkingBoard sessions={[makeWorking({ lastOutput: "更新了输出" })]} onSelect={() => {}} />);
    expect(el.querySelectorAll(".session-item.enter").length).toBe(0);
    // 新条目插入 → 只有新条目播动画
    rerender(
      <WorkingBoard
        sessions={[makeWorking({ lastOutput: "更新了输出" }), makeWorking({ id: "w-2", name: "新任务" })]}
        onSelect={() => {}}
      />,
    );
    const entered = el.querySelectorAll(".session-item.enter");
    expect(entered.length).toBe(1);
    expect(entered[0].textContent).toContain("新任务");
  });
});

describe("AttentionList 等你处理卡", () => {
  it("settled/error 徽章文案正确，点击进入", () => {
    const onSelect = vi.fn();
    const el = render(
      <AttentionList
        sessions={[makeAttention(), makeAttention({ id: "a-2", reason: "error", status: "error", summary: "TypeError" })]}
        onSelect={onSelect}
        now={NOW}
      />,
    );
    expect(el.querySelectorAll(".badge.settled")).toHaveLength(1);
    expect(el.querySelectorAll(".badge.error")).toHaveLength(1);
    expect(el.textContent).toContain("干完了");
    expect(el.textContent).toContain("出错了");
    act(() => {
      (el.querySelector(".attention-card") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith("a-1");
  });
});

describe("SessionTabs 分段按钮组", () => {
  it("渲染 4 个 tab + 计数，点击切换回调", () => {
    const onChange = vi.fn();
    const counts = { all: 4, working: 1, attention: 2, done: 1 };
    const el = render(<SessionTabs value="all" counts={counts} onChange={onChange} />);
    const tabs = el.querySelectorAll("[role=tab]");
    expect(tabs.length).toBe(4);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(el.textContent).toContain("🔥工作中");
    expect(el.textContent).toContain("⚠️等你处理");
    expect(el.textContent).toContain("✅今日完成");
    act(() => {
      (tabs[1] as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("working");
  });

  it("横向滚动容器 + active 滑块：滑块 transform/width 跟随选中 tab（动画只在真实交互发生）", () => {
    const counts = { all: 4, working: 1, attention: 2, done: 1 };
    const el = render(<SessionTabs value="all" counts={counts} onChange={() => {}} />);
    // 横向 tab 组：超宽可横滑容器 + 绝对定位滑块
    expect(el.querySelector(".tab-scroll")).not.toBeNull();
    const slider = el.querySelector(".tab-slider") as HTMLElement;
    expect(slider).not.toBeNull();
    expect(slider.getAttribute("aria-hidden")).toBe("true");
    // 首帧定位不播动画：.ready（transition 开关）未加
    expect(slider.className).not.toContain("ready");
    // jsdom 无布局：注入 offsetLeft/offsetWidth 验证滑块跟随机制
    const tabs = el.querySelectorAll(".tab-btn");
    Object.defineProperty(tabs[0], "offsetLeft", { configurable: true, value: 0 });
    Object.defineProperty(tabs[0], "offsetWidth", { configurable: true, value: 80 });
    Object.defineProperty(tabs[1], "offsetLeft", { configurable: true, value: 88 });
    Object.defineProperty(tabs[1], "offsetWidth", { configurable: true, value: 90 });
    rerender(<SessionTabs value="working" counts={counts} onChange={() => {}} />);
    const moved = el.querySelector(".tab-slider") as HTMLElement;
    expect(moved.style.transform).toBe("translateX(88px)");
    expect(moved.style.width).toBe("90px");
  });
});

describe("StatusBadge 状态变化 150ms 色块闪烁", () => {
  it("status 变化播一次 flash，随后消失；同状态重渲染零动画", () => {
    vi.useFakeTimers();
    const el = render(<StatusBadge status="idle" />);
    const badge = el.querySelector(".badge") as HTMLElement;
    expect(badge.className).not.toContain("flash");
    rerender(<StatusBadge status="idle" />);
    expect(badge.className).not.toContain("flash");
    rerender(<StatusBadge status="running" />);
    const flashed = el.querySelector(".badge") as HTMLElement;
    expect(flashed.className).toContain("flash");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect((el.querySelector(".badge") as HTMLElement).className).not.toContain("flash");
  });
});

describe("NotificationCenter 未读角标与已读", () => {
  const base = {
    loading: false,
    onReload: vi.fn(),
    onMarkAllRead: vi.fn(),
    onMarkRead: vi.fn(),
    onOpenSession: vi.fn(),
  };

  it("未读角标数字 + 打开面板 + 点击通知跳会话", () => {
    const onOpenSession = vi.fn();
    const onReload = vi.fn();
    const el = render(
      <NotificationCenter
        notifications={[makeNotification(), makeNotification({ id: "n-2", read: true, kind: "error" })]}
        unreadCount={1}
        {...base}
        onOpenSession={onOpenSession}
        onReload={onReload}
      />,
    );
    expect(el.querySelector(".notif-badge")?.textContent).toBe("1");
    act(() => {
      (el.querySelector(".notif-bell") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onReload).toHaveBeenCalled();
    expect(el.querySelector(".notif-panel")).not.toBeNull();
    // 已读/未读样式区分
    expect(el.querySelectorAll(".notif-item.unread").length).toBe(1);
    act(() => {
      (el.querySelector(".notif-item") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });

  it("全部已读按钮触发回调", () => {
    const onMarkAllRead = vi.fn();
    const el = render(
      <NotificationCenter
        notifications={[makeNotification()]}
        unreadCount={1}
        {...base}
        onMarkAllRead={onMarkAllRead}
      />,
    );
    act(() => {
      (el.querySelector(".notif-bell") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const markBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "全部已读")!;
    expect((markBtn as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      markBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("无未读时全部已读禁用；空列表显示空态", () => {
    const onMarkAllRead = vi.fn();
    const el = render(<NotificationCenter notifications={[]} unreadCount={0} {...base} onMarkAllRead={onMarkAllRead} />);
    expect(el.querySelector(".notif-badge")).toBeNull();
    act(() => {
      (el.querySelector(".notif-bell") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(el.textContent).toContain("暂无通知");
    const markBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "全部已读")!;
    expect((markBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
