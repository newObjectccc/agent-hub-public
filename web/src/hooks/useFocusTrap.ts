/**
 * 弹层焦点管理（UX 审查 AC6）：Tab 在弹层内循环、Esc 关闭、关闭后焦点归还打开前元素。
 * 供 Sheet / SearchPanel 等 modal 弹层共用；焦点归还也覆盖"组件直接卸载"路径。
 */
import { useEffect, useRef, type RefObject } from "react";

/** 可聚焦元素选择器（禁用/隐藏 tabindex=-1 除外） */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** 弹层内可聚焦元素（文档序） */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface FocusTrapOptions {
  /** 弹层是否打开（false = 不接管） */
  active: boolean;
  /** Esc 关闭回调 */
  onClose: () => void;
  /** 弹层根元素 */
  rootRef: RefObject<HTMLElement | null>;
}

export function useFocusTrap({ active, onClose, rootRef }: FocusTrapOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    // 记住打开前焦点：关闭（含卸载）归还，键盘用户不丢失位置
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 初始焦点交给弹层内第一个可聚焦元素（已有焦点在弹层内则不动）
    if (!root.contains(document.activeElement)) {
      focusableWithin(root)[0]?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        // Shift+Tab 在首个元素/弹层外 → 循环到末尾
        if (current === first || !(current instanceof Node) || !root.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !(current instanceof Node) || !root.contains(current)) {
        // Tab 在末尾元素/弹层外 → 循环回首
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, rootRef]);
}
