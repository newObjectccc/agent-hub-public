/**
 * 面板键盘导航（纯 DOM 操作，便于单测）：
 * - 面板内 items（`data-nav="1"`）ArrowDown/ArrowUp 循环、Home/End 首尾
 * - 输入框侧调用 focusFirst/focusLast 把焦点交给面板（键盘"下一项"可达）
 */

export interface PanelKeyHandle {
  focusFirst(): void;
  focusLast(): void;
}

export function navItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[data-nav="1"]'));
}

export function focusNav(container: HTMLElement | null, which: "first" | "last" | "next" | "prev"): boolean {
  const items = navItems(container);
  if (items.length === 0) return false;
  const activeIndex = items.findIndex((el) => el === document.activeElement);
  let target: HTMLElement;
  switch (which) {
    case "first":
      target = items[0];
      break;
    case "last":
      target = items[items.length - 1];
      break;
    case "next":
      target = items[(activeIndex + 1 + items.length) % items.length];
      break;
    default:
      target = items[(activeIndex - 1 + items.length) % items.length];
      break;
  }
  target.focus();
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}

export interface KeyLike {
  key: string;
  preventDefault(): void;
}

/** 面板根 onKeyDown：方向键循环焦点；返回是否已处理 */
export function handlePanelKeyNav(e: KeyLike, container: HTMLElement | null): boolean {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      return focusNav(container, "next");
    case "ArrowUp":
      e.preventDefault();
      return focusNav(container, "prev");
    case "Home":
      e.preventDefault();
      return focusNav(container, "first");
    case "End":
      e.preventDefault();
      return focusNav(container, "last");
    default:
      return false;
  }
}
