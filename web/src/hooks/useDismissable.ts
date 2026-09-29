/**
 * 统一弹层关闭策略（弹层互斥 bug 修复）：
 * - 点击/触摸外部关闭：pointerdown（覆盖鼠标+触屏）+ touchend + click 三通道，捕获阶段判定，
 *   触屏 tap 与合成 click 都能收起（dismiss 幂等，重复触发无害）。
 * - Escape 关闭。
 * - 全局互斥：同一时刻只允许一个弹层打开（打开时自动关闭其他注册弹层）。
 *   NotificationCenter / SettingsMenu / SessionActionsMenu / SlashCommandPanel /
 *   QuickCommandPanel / FileTreePanel 共用本 hook，行为一致。
 */
import { useEffect, useRef, type RefObject } from "react";

export interface DismissableOptions {
  open: boolean;
  /** 外部点击 / Escape / 被其他弹层挤掉时调用（幂等） */
  onDismiss: () => void;
  /** 弹层根元素（其内部点击不算外部） */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * 触发元素（按钮/输入框等，其上点击不算外部）：
   * toggle 按钮若在 root 外（如输入行的 ⚡），不加 anchor 会出现“打开即被关”的打架。
   */
  anchorRefs?: Array<RefObject<HTMLElement | null>>;
}

/** 当前打开的弹层关闭回调注册表（module 级，实现跨组件互斥） */
const openLayers = new Set<() => void>();

function closeOtherLayers(close: () => void): void {
  for (const other of [...openLayers]) {
    if (other !== close) other();
  }
  openLayers.add(close);
}

export function useDismissable({ open, onDismiss, rootRef, anchorRefs = [] }: DismissableOptions): void {
  // ref 稳定化：effect 只依赖 open，避免回调身份变化导致重复注册/误关
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const anchorRefsRef = useRef(anchorRefs);
  anchorRefsRef.current = anchorRefs;

  useEffect(() => {
    if (!open) return;
    const close = (): void => onDismissRef.current();
    closeOtherLayers(close);

    const isInside = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      if (rootRef.current?.contains(target)) return true;
      return anchorRefsRef.current.some((ref) => ref.current?.contains(target) === true);
    };
    const onOutside = (e: Event): void => {
      if (!isInside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    // capture：不干扰面板内部按钮的冒泡逻辑
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("touchend", onOutside, true);
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      openLayers.delete(close);
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("touchend", onOutside, true);
      document.removeEventListener("click", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, rootRef]);
}
