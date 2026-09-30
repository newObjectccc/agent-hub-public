/**
 * 移动端键盘避让：visualViewport 监听 → 底部被遮高度（--kb-inset）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeInset, useVisualViewportInset } from "./useVisualViewportInset";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("computeInset（纯计算）", () => {
  it("键盘弹出：innerHeight - vv.height - offsetTop > 0 → 取整返回", () => {
    expect(computeInset(800, 500, 0)).toBe(300);
    expect(computeInset(800, 500, 10)).toBe(290);
    expect(computeInset(800, 799.6, 0)).toBe(0);
  });

  it("无键盘/桌面：差值 ≤ 0 → 0（不产生负 inset）", () => {
    expect(computeInset(800, 800, 0)).toBe(0);
    expect(computeInset(800, 900, 0)).toBe(0);
  });
});

describe("useVisualViewportInset（hook）", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("无 visualViewport（桌面/旧浏览器）→ 恒 0 静默降级", () => {
    let value = -1;
    function Probe() {
      value = useVisualViewportInset();
      return null;
    }
    // jsdom 默认无 visualViewport：不动全局 window（避免破坏 react-dom）
    expect(window.visualViewport).toBeUndefined();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Probe />);
    });
    expect(value).toBe(0);
  });

  it("resize 事件触发重新计算；卸载后移除监听", () => {
    const listeners = new Map<string, Set<() => void>>();
    const vv = {
      height: 500,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });

    let value = -1;
    function Probe() {
      value = useVisualViewportInset();
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Probe />);
    });
    expect(value).toBe(300);

    // 键盘收起：resize → 0
    act(() => {
      vv.height = 800;
      listeners.get("resize")?.forEach((fn) => fn());
    });
    expect(value).toBe(0);

    // 键盘再弹出：scroll 事件也算
    act(() => {
      vv.height = 550;
      listeners.get("scroll")?.forEach((fn) => fn());
    });
    expect(value).toBe(250);

    act(() => {
      root!.unmount();
    });
    root = null;
    expect(listeners.get("resize")?.size ?? 0).toBe(0);
    expect(listeners.get("scroll")?.size ?? 0).toBe(0);
    delete (window as unknown as Record<string, unknown>).visualViewport;
    container?.remove();
    container = null;
  });
});
