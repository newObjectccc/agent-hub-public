/**
 * 选区读取纯函数（utils/selection.ts）：
 * 1. readSelectionText：读当前选区文本（无选区/不可用 → ""）
 * 2. countChars：按码点计数（emoji/代理对不拆成两个）
 * 3. hasActiveSelectionIn：root 子树内是否有活动选区（选区锁判定，ChatPage 暂停窗口化用）
 */
import { describe, expect, it } from "vitest";
import { countChars, hasActiveSelectionIn, readSelectionText, type SelectionLike } from "./selection";

function sel(over: Partial<SelectionLike> = {}): SelectionLike {
  return { toString: () => "", isCollapsed: true, rangeCount: 0, anchorNode: null, focusNode: null, ...over };
}

describe("readSelectionText", () => {
  it("返回选区文本；无选区返回空串", () => {
    expect(readSelectionText(sel({ toString: () => "选中的文字" }))).toBe("选中的文字");
    expect(readSelectionText(sel())).toBe("");
    expect(readSelectionText(null)).toBe("");
    expect(readSelectionText(undefined)).toBe("");
  });
});

describe("countChars（按码点，emoji 不拆开算）", () => {
  it("中文逐字、emoji/代理对算一个", () => {
    expect(countChars("你好")).toBe(2);
    expect(countChars("")).toBe(0);
    expect(countChars("👍🏽")).toBe(2); // 手势 + 肤色修饰，两个码点
    expect(countChars("a😀b")).toBe(3); // 😀 是代理对，算一个
  });
});

describe("hasActiveSelectionIn（选区锁判定）", () => {
  const root = document.createElement("div");
  const child = document.createElement("span");
  root.appendChild(child);
  const outside = document.createElement("p");

  it("活动选区锚点在 root 内 → true", () => {
    expect(
      hasActiveSelectionIn(root, sel({ isCollapsed: false, rangeCount: 1, toString: () => "x", anchorNode: child })),
    ).toBe(true);
  });

  it("焦点在 root 内（跨块拖选锚点在外）也算", () => {
    expect(
      hasActiveSelectionIn(root, sel({ isCollapsed: false, rangeCount: 1, toString: () => "x", focusNode: child })),
    ).toBe(true);
  });

  it("折叠选区 / 空选区 / 锚点在 root 外 → false", () => {
    expect(hasActiveSelectionIn(root, sel({ anchorNode: child }))).toBe(false); // isCollapsed 默认 true → 折叠
    expect(
      hasActiveSelectionIn(root, sel({ isCollapsed: false, rangeCount: 1, toString: () => "", anchorNode: child })),
    ).toBe(false);
    expect(
      hasActiveSelectionIn(root, sel({ isCollapsed: false, rangeCount: 1, toString: () => "x", anchorNode: outside })),
    ).toBe(false);
  });

  it("root 为空 / 无 selection 可用 → false", () => {
    expect(hasActiveSelectionIn(null, sel({ isCollapsed: false, rangeCount: 1, toString: () => "x" }))).toBe(false);
    expect(hasActiveSelectionIn(root, null)).toBe(false);
    expect(hasActiveSelectionIn(root, sel({ isCollapsed: false, rangeCount: 0, toString: () => "x", anchorNode: child }))).toBe(false);
  });
});
