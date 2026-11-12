/**
 * 选区读取纯函数（可注入 selection，便于单测）。
 *
 * 移动端复制部分文字的两条链路都靠它：
 * - 菜单「复制所选（N 字）」：打开时读一次 window.getSelection()（不依赖 selectionchange，
 *   iOS Safari <17.4 非可编辑区不触发 selectionchange，这条读取是唯一跨版本路径）
 * - ChatPage 选区锁：判断消息列表内是否有活动选区（有则暂停窗口化，防虚拟裁剪卸载丢选区）
 */

/** Selection 结构子集（jsdom/测试注入用；真实环境传 window.getSelection()） */
export interface SelectionLike {
  toString(): string;
  isCollapsed?: boolean;
  rangeCount?: number;
  anchorNode?: Node | null;
  focusNode?: Node | null;
}

/** 当前选区文本（无选区/不可用返回 ""） */
export function readSelectionText(sel?: SelectionLike | null): string {
  const s = sel ?? currentSelection();
  return s ? s.toString() : "";
}

/** 字数（按码点计，emoji/代理对不拆开算两个） */
export function countChars(text: string): number {
  return Array.from(text).length;
}

/**
 * root 子树内是否有活动（非空、未折叠）选区。
 * 锚点/焦点任一落在 root 内即算（跨块拖选时 anchor 可能在另一个气泡）。
 */
export function hasActiveSelectionIn(root: Node | null | undefined, sel?: SelectionLike | null): boolean {
  if (!root) return false;
  const s = sel ?? currentSelection();
  if (!s) return false;
  if (s.isCollapsed === true) return false;
  if (typeof s.rangeCount === "number" && s.rangeCount <= 0) return false;
  if (s.toString() === "") return false;
  const anchor = s.anchorNode ?? null;
  const focus = s.focusNode ?? null;
  return (anchor !== null && root.contains(anchor)) || (focus !== null && root.contains(focus));
}

function currentSelection(): SelectionLike | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  return window.getSelection();
}
