/**
 * ToastHost（UX 审查 AC6）：toast 可手动关闭（✕），文案与去重/上限逻辑协同。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToastHost } from "./ToastHost";
import { dismissToast, getToasts, showToast } from "../utils/toast";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ToastHost />);
  });
  return container;
}

beforeEach(() => {
  for (const t of getToasts()) dismissToast(t.id);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  for (const t of getToasts()) dismissToast(t.id);
});

function touch(el: Element, type: "touchstart" | "touchend", x: number, y: number): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, type === "touchstart" ? "touches" : "changedTouches", {
    value: [{ clientX: x, clientY: y }],
  });
  act(() => {
    el.dispatchEvent(e);
  });
}

describe("ToastHost 手动关闭", () => {
  it("每条 toast 带 ✕ 关闭按钮（aria-label 可达），点击即移除该条", () => {
    const el = render();
    act(() => {
      showToast("提示一");
      showToast("提示二");
    });
    const toasts = el.querySelectorAll(".toast");
    expect(toasts).toHaveLength(2);
    const closeBtns = el.querySelectorAll<HTMLButtonElement>(".toast-close");
    expect(closeBtns).toHaveLength(2);
    expect(closeBtns[0].getAttribute("aria-label")).toBe("关闭提示");
    act(() => {
      closeBtns[0].click();
    });
    expect(el.querySelectorAll(".toast")).toHaveLength(1);
    expect(el.textContent).toContain("提示二");
    expect(el.textContent).not.toContain("提示一");
  });

  it("宿主 aria-live=polite（屏幕阅读器播报但不打断）", () => {
    const el = render();
    expect(el.querySelector(".toast-host")?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("ToastHost 滑动关闭（加分手势）", () => {
  it("横向滑动 toast 直接 dismiss，不影响其他条", () => {
    const el = render();
    act(() => {
      showToast("滑走我");
      showToast("留下我");
    });
    const first = el.querySelector(".toast")!;
    touch(first, "touchstart", 240, 300);
    touch(first, "touchend", 120, 304);
    expect(el.querySelectorAll(".toast")).toHaveLength(1);
    expect(el.textContent).toContain("留下我");
    expect(el.textContent).not.toContain("滑走我");
  });

  it("纵向拖动不误关（留给页面滚动）", () => {
    const el = render();
    act(() => {
      showToast("别走");
    });
    const toast = el.querySelector(".toast")!;
    touch(toast, "touchstart", 240, 300);
    touch(toast, "touchend", 236, 180);
    expect(el.querySelectorAll(".toast")).toHaveLength(1);
  });

  it("滑动后的下一次 tap 不被吞：✕ 仍能关下一条", () => {
    const el = render();
    act(() => {
      showToast("第一条");
    });
    const first = el.querySelector(".toast")!;
    touch(first, "touchstart", 240, 300);
    touch(first, "touchend", 120, 300);
    act(() => {
      showToast("第二条");
    });
    const closeBtns = el.querySelectorAll<HTMLButtonElement>(".toast-close");
    const target = closeBtns[closeBtns.length - 1];
    // 真实 tap：touchstart/touchend 之后浏览器补发 click（新一轮触摸复位滑动标记）
    touch(target, "touchstart", 260, 300);
    touch(target, "touchend", 260, 300);
    act(() => {
      target.click();
    });
    expect(el.textContent).not.toContain("第二条");
  });
});
