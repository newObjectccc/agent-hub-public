/**
 * Enter 发送语义（UX 审查 AC4）：触屏上回车默认=换行（既有习惯，不推翻），
 * 但两种情况允许 Enter 发送：
 * 1. 外接物理键盘：检测到物理键盘事件模式（软键盘不会发的键/组合）→ Enter 发送
 * 2. 桌面（非 pointer:coarse）：保持原行为 Enter 发送
 * 另加输入法组合冷却：compositionend 后短窗内 Enter 不触发发送（防中文输入法误发）。
 * 纯函数 + 可注入 tracker，可单测。
 */

/** compositionend 后的 Enter 冷却窗口（ms）：输入法确认候选词的回车不误触发送 */
export const COMPOSITION_COOLDOWN_MS = 350;

export interface KeydownLike {
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * 物理键盘证据键：软键盘（iOS/Android）基本不会产生这些键事件。
 * Tab/方向键/翻页/Home/End/Fn 组合、Ctrl/Meta+单键 → 判定为外接键盘。
 */
const EVIDENCE_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
]);

/** 单个 keydown 是否构成“物理键盘”证据 */
export function isPhysicalKeyEvidence(e: KeydownLike): boolean {
  if (EVIDENCE_KEYS.has(e.key)) return true;
  if (e.key.length === 1 && (e.metaKey === true || e.ctrlKey === true)) return true;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return true;
  return false;
}

/** 物理键盘检测器：累积 keydown 证据（保守——无证据一律按软键盘处理） */
export class PhysicalKeyboardTracker {
  private evidence = false;

  handleKeydown(e: KeydownLike): void {
    if (!this.evidence && isPhysicalKeyEvidence(e)) this.evidence = true;
  }

  /** 已观测到物理键盘事件模式 */
  get detected(): boolean {
    return this.evidence;
  }
}

export interface EnterSendDecision {
  key: string;
  shiftKey: boolean;
  /** 输入法组合中（nativeEvent.isComposing） */
  isComposing: boolean;
  /** compositionend 冷却截止时间戳 */
  compositionCooldownUntil: number;
  now: number;
  /** 触屏 UI（pointer: coarse） */
  touchUI: boolean;
  /** 已检测到外接物理键盘 */
  physicalKeyboard: boolean;
}

/** Enter 是否触发发送（其余情况：换行 / 交给输入法 / 面板选择） */
export function shouldSendOnEnter(d: EnterSendDecision): boolean {
  if (d.key !== "Enter") return false;
  if (d.shiftKey) return false;
  // 输入法组合期/组合刚结束的冷却窗内绝不发送（防中文输入法回车误发）
  if (d.isComposing) return false;
  if (d.now < d.compositionCooldownUntil) return false;
  // 触屏默认回车=换行（用户习惯）；有外接键盘证据或本就非触屏才发送
  if (d.touchUI && !d.physicalKeyboard) return false;
  return true;
}
