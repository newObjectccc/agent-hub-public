/**
 * Enter 发送语义（UX 审查 AC4）：
 * - 输入法组合期/组合后冷却不触发发送（防中文输入法回车误发）
 * - 触屏默认回车=换行（习惯不推翻）；外接物理键盘证据出现后才允许 Enter 发送
 */
import { describe, expect, it } from "vitest";
import {
  COMPOSITION_COOLDOWN_MS,
  PhysicalKeyboardTracker,
  isPhysicalKeyEvidence,
  shouldSendOnEnter,
  type EnterSendDecision,
} from "./keyboard";

function decision(patch: Partial<EnterSendDecision> = {}): EnterSendDecision {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    compositionCooldownUntil: 0,
    now: 1000,
    touchUI: false,
    physicalKeyboard: false,
    ...patch,
  };
}

describe("shouldSendOnEnter", () => {
  it("桌面（非触屏）Enter 发送；Shift+Enter 换行", () => {
    expect(shouldSendOnEnter(decision())).toBe(true);
    expect(shouldSendOnEnter(decision({ shiftKey: true }))).toBe(false);
  });

  it("非 Enter 键不触发", () => {
    expect(shouldSendOnEnter(decision({ key: "a" }))).toBe(false);
  });

  it("输入法组合期（isComposing）绝不发送", () => {
    expect(shouldSendOnEnter(decision({ isComposing: true }))).toBe(false);
  });

  it("compositionend 后的冷却窗内不发送（防中文输入法回车误发）", () => {
    const now = 10_000;
    expect(
      shouldSendOnEnter(decision({ now, compositionCooldownUntil: now + COMPOSITION_COOLDOWN_MS - 1 })),
    ).toBe(false);
    // 冷却结束后恢复
    expect(shouldSendOnEnter(decision({ now: now + COMPOSITION_COOLDOWN_MS, compositionCooldownUntil: now }))).toBe(true);
  });

  it("触屏（软键盘）回车=换行：不发送", () => {
    expect(shouldSendOnEnter(decision({ touchUI: true }))).toBe(false);
  });

  it("触屏 + 外接物理键盘：Enter 可发送（修复触屏+键盘无法回车发送）", () => {
    expect(shouldSendOnEnter(decision({ touchUI: true, physicalKeyboard: true }))).toBe(true);
  });
});

describe("PhysicalKeyboardTracker（外接键盘检测启发式）", () => {
  it("Tab/方向键等软键盘不发的键 → 判定物理键盘", () => {
    const t = new PhysicalKeyboardTracker();
    expect(t.detected).toBe(false);
    t.handleKeydown({ key: "Tab" });
    expect(t.detected).toBe(true);
  });

  it("Ctrl/Meta+单键组合 → 判定物理键盘", () => {
    const t = new PhysicalKeyboardTracker();
    t.handleKeydown({ key: "c", ctrlKey: true });
    expect(t.detected).toBe(true);
  });

  it("普通字符键（软键盘也会发）不构成证据", () => {
    const t = new PhysicalKeyboardTracker();
    t.handleKeydown({ key: "a" });
    t.handleKeydown({ key: "Enter" });
    t.handleKeydown({ key: "Backspace" });
    expect(t.detected).toBe(false);
    expect(isPhysicalKeyEvidence({ key: "F5" })).toBe(true);
    expect(isPhysicalKeyEvidence({ key: "PageDown" })).toBe(true);
    expect(isPhysicalKeyEvidence({ key: "x" })).toBe(false);
  });
});
