/**
 * 会话 tab 滑块定位专项（H1 UI 精修·老病根根治）：
 * 1. counts（徽标数字）变化引起按钮变宽 → 滑块宽度跟随重测（老 bug：挂载瞬间测一次，之后不跟）
 * 2. 布局不可测（offsetWidth=0）→ 滑块 misaligned 兜底（隐藏滑块，active 态由纯 CSS 承载）
 * 3. 布局就绪后重测 → 恢复对齐、misaligned 消除
 * 4. 动画门控：首帧/重挂载不播动画，真实点击切换才 ready
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTabs } from "./SessionTabs";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

/** 可变 mock 布局（模拟字体/徽标迟到导致按钮变宽） */
const layout = { left: 0, width: 96 };

function mockLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("tab-btn") ? layout.left : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("tab-btn") ? layout.width : 320;
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

function render(
  counts: Record<string, number> = { all: 5, working: 1, attention: 2, done: 2 },
  value: "all" | "working" | "attention" | "done" = "all",
  onChange: (tab: string) => void = () => {},
): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<SessionTabs value={value} counts={counts as never} onChange={onChange as never} />);
  });
  return container;
}

/** 等 rAF 链走完（scheduleMeasure 门控在 rAF 里） */
async function flushRaf(times = 2): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  });
}

beforeEach(() => {
  layout.left = 0;
  layout.width = 96;
  mockLayout();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("SessionTabs 滑块对齐（H1 老病根）", () => {
  it("counts 变化（徽标数字变宽）后滑块宽度跟随重测", () => {
    const el = render({ all: 5, working: 1, attention: 2, done: 2 });
    const slider = el.querySelector<HTMLElement>(".tab-slider")!;
    expect(slider.style.width).toBe("96px");

    // 老 bug 复现条件：数据回来后按钮变宽（133 vs 5），滑块若不重测就窄 13.9px
    layout.width = 120;
    act(() => {
      root!.render(<SessionTabs value="all" counts={{ all: 133, working: 10, attention: 20, done: 30 }} onChange={() => {}} />);
    });
    expect(slider.style.width).toBe("120px");
  });

  it("布局不可测（offsetWidth=0）→ misaligned 兜底：滑块隐藏、active 态走纯 CSS", async () => {
    const el = render();
    const slider = el.querySelector<HTMLElement>(".tab-slider")!;
    expect(slider.classList.contains("misaligned")).toBe(false);

    // 字体/布局未就绪：按钮不可测
    layout.width = 0;
    window.dispatchEvent(new Event("resize"));
    await flushRaf();
    expect(slider.classList.contains("misaligned")).toBe(true);

    // 布局就绪后重测：恢复对齐
    layout.width = 96;
    window.dispatchEvent(new Event("resize"));
    await flushRaf();
    expect(slider.classList.contains("misaligned")).toBe(false);
    expect(slider.style.width).toBe("96px");
  });

  it("页面可见性/返回导航（pageshow）触发重测，滑块不残留错位", async () => {
    const el = render();
    const slider = el.querySelector<HTMLElement>(".tab-slider")!;
    layout.left = 200;
    layout.width = 110;
    window.dispatchEvent(new Event("pageshow"));
    await flushRaf();
    expect(slider.style.transform).toBe("translateX(200px)");
    expect(slider.style.width).toBe("110px");
  });

  it("动画门控：首帧不播动画（无 ready），真实点击切换后才 ready", () => {
    // 受控模拟：点击 → 父组件改 value（与 SessionsPage 行为一致）
    let current: "all" | "working" | "attention" | "done" = "all";
    const el = render({ all: 5, working: 1, attention: 2, done: 2 }, current, (tab) => {
      current = tab as typeof current;
    });
    const slider = el.querySelector<HTMLElement>(".tab-slider")!;
    expect(slider.classList.contains("ready")).toBe(false);
    const tabs = el.querySelectorAll<HTMLButtonElement>(".tab-btn");
    act(() => {
      tabs[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      root!.render(<SessionTabs value={current} counts={{ all: 5, working: 1, attention: 2, done: 2 } as never} onChange={() => {}} />);
    });
    expect(slider.classList.contains("ready")).toBe(true);
  });
});
