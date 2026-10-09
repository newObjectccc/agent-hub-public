/**
 * markAllRead 失败回滚回归（P2）：全部已读乐观清零后服务端持久化失败 →
 * 回滚对齐服务端状态（参照单条 markRead 的回滚模式），角标不静默停留在假的"已清零"。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "../api/types";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getNotifications: mocks.getNotifications,
    markNotificationsRead: mocks.markNotificationsRead,
  },
}));

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: () => undefined,
}));

vi.mock("../hooks/useIsMobile", () => ({
  useIsMobile: () => true,
}));

import { AppShell } from "./AppShell";

const item = (id: string): NotificationItem => ({
  id,
  sessionId: `s-${id}`,
  sessionName: null,
  kind: "settled",
  text: `通知 ${id}`,
  timestamp: "2026-02-18T11:00:00.000Z",
  read: false,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AppShell route={{ name: "home" }}>
        <div />
      </AppShell>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.getNotifications.mockReset();
  mocks.getNotifications.mockResolvedValue({ notifications: [item("n1"), item("n2")], unreadCount: 2 });
  mocks.markNotificationsRead.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("AppShell markAllRead 失败回滚", () => {
  it("全部已读持久化失败 → 重新拉取服务端状态回滚（角标恢复未读）", async () => {
    mocks.markNotificationsRead.mockRejectedValue(new Error("网络错误"));
    const el = await render();
    // 打开通知面板（onReload 再拉一次）
    click(el.querySelector(".notif-bell"));
    await act(async () => {
      await Promise.resolve();
    });
    const callsBefore = mocks.getNotifications.mock.calls.length;

    const markAllBtn = Array.from(el.querySelectorAll<HTMLButtonElement>(".notif-panel button")).find(
      (b) => b.textContent === "全部已读",
    );
    await act(async () => {
      markAllBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.markNotificationsRead).toHaveBeenCalledTimes(1);
    // 失败 → 回滚拉取（不静默停留在乐观清零态）
    expect(mocks.getNotifications.mock.calls.length).toBeGreaterThan(callsBefore);
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector(".notif-bell")?.getAttribute("aria-label")).toContain("2 条未读");
  });

  it("全部已读成功 → 不回滚（角标清零）", async () => {
    mocks.markNotificationsRead.mockResolvedValue({ ok: true, unreadCount: 0 });
    mocks.getNotifications.mockResolvedValue({ notifications: [item("n1"), item("n2")], unreadCount: 2 });
    const el = await render();
    click(el.querySelector(".notif-bell"));
    await act(async () => {
      await Promise.resolve();
    });
    const callsBefore = mocks.getNotifications.mock.calls.length;
    const markAllBtn = Array.from(el.querySelectorAll<HTMLButtonElement>(".notif-panel button")).find(
      (b) => b.textContent === "全部已读",
    );
    await act(async () => {
      markAllBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getNotifications.mock.calls.length).toBe(callsBefore);
    expect(el.querySelector(".notif-bell")?.getAttribute("aria-label")).toBe("通知");
  });
});
