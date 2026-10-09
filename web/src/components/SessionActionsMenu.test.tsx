/**
 * 会话操作菜单测试：展开/收起、「复制为新会话」触发 onFork、Esc 关闭。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./SessionActionsMenu";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("SessionActionsMenu", () => {
  it("默认收起；点 ⋯ 展开出「复制为新会话」菜单项", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} />);
    expect(el.querySelector(".action-menu")).toBeNull();
    click(el.querySelector('button[aria-label="会话操作"]'));
    const item = el.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("复制为新会话");
  });

  it("点「复制为新会话」→ onFork 调用一次且菜单关闭", () => {
    const onFork = vi.fn();
    const el = render(<SessionActionsMenu onFork={onFork} />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    click(el.querySelector('[role="menuitem"]'));
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".action-menu")).toBeNull();
  });

  it("Esc 关闭菜单", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    expect(el.querySelector(".action-menu")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector(".action-menu")).toBeNull();
  });

  it("forkBusy 时菜单项禁用并显示复制中", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} forkBusy />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    const item = el.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("复制中");
  });

  it("传 onRename 时菜单含「重命名」项：点击触发 onRename 且菜单关闭", () => {
    const onRename = vi.fn();
    const el = render(<SessionActionsMenu onFork={() => undefined} onRename={onRename} />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    const items = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const renameItem = items.find((i) => i.textContent?.includes("重命名"));
    expect(renameItem).toBeDefined();
    expect(renameItem!.getAttribute("title")).toContain("名字");
    click(renameItem!);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".action-menu")).toBeNull();
  });

  it("未传 onRename 时不显示「重命名」项（向后兼容）", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    const items = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.some((i) => i.textContent?.includes("重命名"))).toBe(false);
  });

  it("触发按钮无障碍语义完整：aria-label + aria-haspopup=menu + aria-expanded 随开合", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} />);
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("键盘闭环：菜单内按 Esc 关闭且焦点归还触发按钮（不丢失位置）", () => {
    const el = render(<SessionActionsMenu onFork={() => undefined} />);
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]')!;
    click(trigger);
    const item = el.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => {
      item.focus();
    });
    act(() => {
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector(".action-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("键盘可达：菜单项为原生 button（Tab 可达、Enter/Space 可触发）", () => {
    const onFork = vi.fn();
    const el = render(<SessionActionsMenu onFork={onFork} />);
    click(el.querySelector('button[aria-label="会话操作"]'));
    const item = el.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.tagName).toBe("BUTTON");
    expect(item.tabIndex).toBe(0);
    act(() => {
      item.focus();
    });
    act(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});
