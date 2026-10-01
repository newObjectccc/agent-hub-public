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
