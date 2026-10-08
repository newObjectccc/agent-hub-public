/**
 * NoticeBanner 手动关闭（UX 反馈：顶部提示要能关掉）：
 * 1. ✕ 按钮（.icon-btn 规范、aria-label）点击后该条消失
 * 2. 已关闭/已读记入 localStorage（bgHintDismissed 同模式）：同一条通知刷新后不重复弹
 * 3. 横向滑动关闭（加分手势）；纵向拖动不误关；滑动后的合成 click 不误触导航
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "../api/types";
import { NOTICE_DISMISS_KEY } from "../utils/noticeDismiss";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
  onNotification: null as ((n: import("../api/types").NotificationItem) => void) | null,
  navigate: vi.fn(),
}));

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: (opts: { onNotification: (n: import("../api/types").NotificationItem) => void }) => {
    captured.onNotification = opts.onNotification;
  },
}));

vi.mock("../utils/router", () => ({
  navigate: captured.navigate,
}));

import { NoticeBanner } from "./NoticeBanner";

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<NoticeBanner />);
  });
  return container;
}

function fire(partial: Partial<NotificationItem> & { id: string }): void {
  act(() => {
    captured.onNotification?.({
      sessionId: "s1",
      sessionName: "演示会话",
      kind: "settled",
      text: "任务完成了",
      timestamp: "2026-02-18T11:00:00.000Z",
      read: false,
      ...partial,
    });
  });
}

function touch(el: Element, type: "touchstart" | "touchend", x: number, y: number): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, type === "touchstart" ? "touches" : "changedTouches", {
    value: [{ clientX: x, clientY: y }],
  });
  act(() => {
    el.dispatchEvent(e);
  });
}

function dismissedIds(): string[] {
  return JSON.parse(localStorage.getItem(NOTICE_DISMISS_KEY) ?? "[]") as string[];
}

beforeEach(() => {
  localStorage.clear();
  captured.onNotification = null;
  captured.navigate.mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("NoticeBanner ✕ 手动关闭", () => {
  it("横幅可弹出；✕ 带 aria-label，点击后该条消失并记住已关闭", () => {
    const el = render();
    fire({ id: "n1" });
    expect(el.querySelector(".notice-banner")).not.toBeNull();
    expect(el.querySelector(".notice-banner")!.getAttribute("aria-live")).toBe("polite");

    const close = el.querySelector<HTMLButtonElement>(".notice-banner-close");
    expect(close).not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBe("关闭提示");
    act(() => {
      close!.click();
    });
    expect(el.querySelector(".notice-banner")).toBeNull();
    expect(dismissedIds()).toEqual(["n1"]);
  });

  it("已关闭的通知刷新后不重复弹（localStorage 持久化，新通知照常弹）", () => {
    let el = render();
    fire({ id: "n1" });
    act(() => {
      el.querySelector<HTMLButtonElement>(".notice-banner-close")!.click();
    });
    // 同一次会话内重复到达：不重复弹
    fire({ id: "n1" });
    expect(el.querySelector(".notice-banner")).toBeNull();

    // 模拟刷新：卸载重挂（localStorage 是唯一记忆载体）
    act(() => {
      root!.unmount();
    });
    container!.remove();
    el = render();
    fire({ id: "n1" });
    expect(el.querySelector(".notice-banner")).toBeNull();
    fire({ id: "n2", kind: "error", text: "炸了" });
    expect(el.querySelector(".notice-banner")).not.toBeNull();
    expect(el.querySelector(".notice-banner")!.textContent).toContain("出错了");
    expect(el.querySelector(".notice-banner")!.textContent).toContain("炸了");
  });
});

describe("NoticeBanner 点击进入 / 滑动关闭", () => {
  it("点击主体：进入会话 + 记住已读（同条不再弹）", () => {
    const el = render();
    fire({ id: "n3" });
    act(() => {
      el.querySelector<HTMLButtonElement>(".notice-banner-hit")!.click();
    });
    expect(captured.navigate).toHaveBeenCalledWith("/s/s1");
    expect(el.querySelector(".notice-banner")).toBeNull();
    expect(dismissedIds()).toEqual(["n3"]);
  });

  it("横向滑动关闭该条 + 记住已关闭；滑动后的合成 click 不误触导航", () => {
    const el = render();
    fire({ id: "n4" });
    const banner = el.querySelector(".notice-banner")!;
    const hit = el.querySelector<HTMLButtonElement>(".notice-banner-hit")!;
    act(() => {
      // 真实手势序列：touchstart → touchend → 浏览器补发合成 click（落点在主体上）
      // 三者同一事件循环回合，必须一口气派发才能复现"合成 click 打在还没卸的按钮上"
      const pair = (type: "touchstart" | "touchend", x: number, y: number) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, type === "touchstart" ? "touches" : "changedTouches", {
          value: [{ clientX: x, clientY: y }],
        });
        return e;
      };
      banner.dispatchEvent(pair("touchstart", 300, 80));
      banner.dispatchEvent(pair("touchend", 180, 84));
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector(".notice-banner")).toBeNull();
    expect(dismissedIds()).toEqual(["n4"]);
    expect(captured.navigate).not.toHaveBeenCalled();
  });

  it("纵向拖动（页面滚动意图）不误关", () => {
    const el = render();
    fire({ id: "n5" });
    const banner = el.querySelector(".notice-banner")!;
    touch(banner, "touchstart", 300, 80);
    touch(banner, "touchend", 292, 240);
    expect(el.querySelector(".notice-banner")).not.toBeNull();
    expect(dismissedIds()).toEqual([]);
  });
});
