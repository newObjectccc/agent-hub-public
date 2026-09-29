/**
 * NotificationCenter 行为回归（通知列表逻辑修复）：
 * 点击条目跳转并标记该条已读、子代理聚合展开、done 不高亮未读、与设置菜单弹层互斥。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "../api/types";
import { NotificationCenter } from "./NotificationCenter";
import { SettingsMenu } from "./SettingsMenu";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: "n-1",
    sessionId: "s-1",
    sessionName: "主会话",
    kind: "settled",
    text: "已完成：修复构建",
    timestamp: "2026-02-18T11:00:00.000Z",
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

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openBell(el: HTMLElement): void {
  click(el.querySelector(".notif-bell"));
  expect(el.querySelector(".notif-panel")).not.toBeNull();
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("NotificationCenter 点击即已读", () => {
  it("点击条目：onMarkRead(该条 id) + onOpenSession + 面板关闭", () => {
    const onMarkRead = vi.fn();
    const onOpenSession = vi.fn();
    const el = render(
      <NotificationCenter
        notifications={[item({ id: "n-1", sessionId: "s-1" }), item({ id: "n-2", sessionId: "s-2", read: true })]}
        unreadCount={1}
        loading={false}
        onReload={() => undefined}
        onMarkAllRead={() => undefined}
        onMarkRead={onMarkRead}
        onOpenSession={onOpenSession}
      />,
    );
    openBell(el);
    click(el.querySelector(".notif-item"));
    expect(onMarkRead).toHaveBeenCalledWith("n-1");
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
    expect(el.querySelector(".notif-panel")).toBeNull();
  });

  it("done（已中止）条目不高亮未读（噪声不计待办）", () => {
    const el = render(
      <NotificationCenter
        notifications={[item({ id: "d-1", kind: "done", read: false })]}
        unreadCount={0}
        loading={false}
        onReload={() => undefined}
        onMarkAllRead={() => undefined}
        onMarkRead={() => undefined}
        onOpenSession={() => undefined}
      />,
    );
    openBell(el);
    expect(el.querySelector(".notif-item.unread")).toBeNull();
  });
});

describe("NotificationCenter 子代理聚合", () => {
  const subItems = [
    item({ id: "sub-1", sessionId: "developer#1", isSubAgent: true }),
    item({ id: "sub-2", sessionId: "acceptance-reviewer#2", isSubAgent: true, timestamp: "2026-02-18T10:00:00.000Z" }),
  ];

  it("子代理通知聚合为一行，主会话通知在前；点开查看显示明细", () => {
    const el = render(
      <NotificationCenter
        notifications={[...subItems, item({ id: "main-1" })]}
        unreadCount={3}
        loading={false}
        onReload={() => undefined}
        onMarkAllRead={() => undefined}
        onMarkRead={() => undefined}
        onOpenSession={() => undefined}
      />,
    );
    openBell(el);
    // 主会话行在前，聚合行在最后
    const rows = Array.from(el.querySelectorAll(".notif-list > li"));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".notif-item")).not.toBeNull();
    const groupTitle = el.querySelector(".notif-group-title")?.textContent ?? "";
    expect(groupTitle).toContain("🤖 2 个子代理完成");
    expect(el.querySelector(".notif-group-head .notif-badge")?.textContent).toBe("2");
    // 默认收起，点开查看
    expect(el.querySelector(".notif-group-list")).toBeNull();
    click(el.querySelector(".notif-group-head"));
    const subs = el.querySelectorAll(".notif-sub-item");
    expect(subs).toHaveLength(2);
  });

  it("点击聚合明细条目：onMarkRead + onOpenSession（子代理通知也能跳转/已读）", () => {
    const onMarkRead = vi.fn();
    const onOpenSession = vi.fn();
    const el = render(
      <NotificationCenter
        notifications={subItems}
        unreadCount={2}
        loading={false}
        onReload={() => undefined}
        onMarkAllRead={() => undefined}
        onMarkRead={onMarkRead}
        onOpenSession={onOpenSession}
      />,
    );
    openBell(el);
    click(el.querySelector(".notif-group-head"));
    click(el.querySelector(".notif-sub-item"));
    expect(onMarkRead).toHaveBeenCalledWith("sub-1");
    expect(onOpenSession).toHaveBeenCalledWith("developer#1");
  });

  it("子代理 error 独立显示（不被聚合淹没）", () => {
    const el = render(
      <NotificationCenter
        notifications={[
          item({ id: "sub-e", sessionId: "developer#9", isSubAgent: true, kind: "error", text: "任务失败" }),
          item({ id: "sub-s", isSubAgent: true }),
        ]}
        unreadCount={2}
        loading={false}
        onReload={() => undefined}
        onMarkAllRead={() => undefined}
        onMarkRead={() => undefined}
        onOpenSession={() => undefined}
      />,
    );
    openBell(el);
    const first = el.querySelector(".notif-list > li .notif-item");
    expect(first?.textContent).toContain("任务失败");
    expect(el.querySelector(".notif-group-title")?.textContent).toContain("1 个子代理完成");
  });
});

describe("NotificationCenter 与设置菜单互斥（弹层 bug 回归）", () => {
  it("通知面板开着时点设置：通知收起、设置打开（点别的按钮旧菜单收起）", () => {
    const el = render(
      <div>
        <NotificationCenter
          notifications={[item({})]}
          unreadCount={1}
          loading={false}
          onReload={() => undefined}
          onMarkAllRead={() => undefined}
          onMarkRead={() => undefined}
          onOpenSession={() => undefined}
        />
        <SettingsMenu />
      </div>,
    );
    openBell(el);
    const gear = el.querySelector('button[aria-label="设置"]')!;
    act(() => {
      gear.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector(".notif-panel")).toBeNull();
    expect(el.querySelector(".settings-panel")).not.toBeNull();
    // 触屏 tap 场景：点外部 touchend 也能收起设置面板
    act(() => {
      document.body.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(el.querySelector(".settings-panel")).toBeNull();
  });
});
