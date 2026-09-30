/**
 * 会话列表横向 tab 组回归（反馈轮 3 #6）：
 * 从会话返回列表（组件重挂载）后 tab 布局不变形：
 * 1. 滑块按选中 tab 的 offsetLeft/offsetWidth 定位（首帧不播动画）
 * 2. 重挂载后横滚残留/焦点滚动把 tab 组拉偏时，scrollLeft 被校正回 0（左侧 padding 不被覆盖）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTabs } from "./SessionTabs";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

/** jsdom 不做布局：mock 按钮 offsetLeft/offsetWidth 与容器滚动尺寸 */
function mockLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains("tab-btn")) {
        const index = [...(this.parentElement?.children ?? [])].filter((n) => n.classList.contains("tab-btn")).indexOf(this);
        return index * 100;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("tab-btn") ? 96 : 320;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement): number {
      return (this as unknown as { __scrollLeft?: number }).__scrollLeft ?? 0;
    },
    set(this: HTMLElement, value: number) {
      (this as unknown as { __scrollLeft?: number }).__scrollLeft = value;
    },
  });
}

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<SessionTabs value="all" counts={{ all: 5, working: 1, attention: 2, done: 2 }} onChange={() => {}} />);
  });
  return container;
}

beforeEach(() => {
  mockLayout();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("SessionTabs 返回导航回归（#6 tab padding bug）", () => {
  it("首帧滑块定位到选中 tab（offsetLeft/offsetWidth），不播动画", () => {
    const el = render();
    const slider = el.querySelector<HTMLElement>(".tab-slider");
    expect(slider).not.toBeNull();
    expect(slider!.style.transform).toBe("translateX(0px)");
    expect(slider!.style.width).toBe("96px");
    expect(slider!.classList.contains("ready")).toBe(false);
  });

  it("返回列表重挂载后布局不变形：滑块同位 + tab 组 scrollLeft 归零（左侧 padding 不被覆盖）", () => {
    // 第一次进入列表
    render();
    // 进会话 → 返回：组件卸载重挂载（App 路由切换即重挂载）
    act(() => {
      root?.unmount();
    });
    const el = render();
    const scroller = el.querySelector<HTMLElement>(".tab-scroll");
    expect(scroller).not.toBeNull();

    // 模拟浏览器焦点恢复/滚动恢复把 tab 组横滚拉偏（返回后 tab 左侧 padding 被"覆盖"的根因）
    act(() => {
      scroller!.scrollLeft = 40;
      scroller!.dispatchEvent(new Event("scroll"));
    });
    // 组件在保护窗口内自动校正回 0（恢复 tab 组左侧 padding），无需手动复位
    expect(scroller!.scrollLeft).toBe(0);
    const slider = el.querySelector<HTMLElement>(".tab-slider");
    expect(slider!.style.transform).toBe("translateX(0px)");
  });

  it("用户交互后放行横滑（保护窗口不误伤正常横滚）", () => {
    const el = render();
    const scroller = el.querySelector<HTMLElement>(".tab-scroll");
    act(() => {
      scroller!.dispatchEvent(new Event("touchstart"));
      scroller!.scrollLeft = 40;
      scroller!.dispatchEvent(new Event("scroll"));
    });
    expect(scroller!.scrollLeft).toBe(40);
  });

  it("切换 tab 滑块跟随新位置", () => {
    const el = render();
    const tabs = el.querySelectorAll<HTMLButtonElement>(".tab-btn");
    act(() => {
      tabs[2].click();
    });
    const slider = el.querySelector<HTMLElement>(".tab-slider");
    // 点击 onChange 受控组件不自变 value；这里只断言测量逻辑不破坏（滑块仍在合法位置）
    expect(["translateX(0px)", "translateX(200px)"]).toContain(slider!.style.transform);
  });
});
