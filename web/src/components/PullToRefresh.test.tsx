/**
 * PullToRefresh 手势纪律（H1 滚动体验专项）：
 * 1. 上滑（列表拖动滚动）零干扰：不进入下拉模式、不触发刷新、内容不位移
 * 2. 下拉超过阈值松手才触发刷新（一次）；不足阈值不触发
 * 3. 未到顶（内部滚动容器还有内容）不接管手势
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "./PullToRefresh";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(onRefresh: () => void, children: React.ReactNode = <div data-ptr-scroll="" />): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <PullToRefresh onRefresh={onRefresh} thresholdPx={72}>
        {children}
      </PullToRefresh>,
    );
  });
  return container;
}

function touch(el: Element, type: string, clientY: number): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? [] : [{ clientY }],
  });
  act(() => {
    el.dispatchEvent(ev);
  });
}

async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("PullToRefresh 手势纪律（滚动体验）", () => {
  it("上滑拖动（列表滚动）零干扰：不刷新、内容不位移", async () => {
    const onRefresh = vi.fn();
    const el = render(onRefresh);
    const ptr = el.querySelector(".ptr")!;
    const content = el.querySelector<HTMLElement>(".ptr-content")!;

    touch(ptr, "touchstart", 400);
    for (let y = 380; y >= 200; y -= 30) touch(ptr, "touchmove", y);
    await flushRaf();
    touch(ptr, "touchend", 200);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(content.style.transform).toBe("");
  });

  it("下拉超过阈值松手触发刷新（一次）", async () => {
    const onRefresh = vi.fn();
    const el = render(onRefresh);
    const ptr = el.querySelector(".ptr")!;

    touch(ptr, "touchstart", 100);
    for (let y = 120; y <= 320; y += 40) touch(ptr, "touchmove", y);
    await flushRaf();
    touch(ptr, "touchend", 320);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("下拉不足阈值不触发刷新", async () => {
    const onRefresh = vi.fn();
    const el = render(onRefresh);
    const ptr = el.querySelector(".ptr")!;

    touch(ptr, "touchstart", 100);
    for (let y = 120; y <= 180; y += 20) touch(ptr, "touchmove", y);
    await flushRaf();
    touch(ptr, "touchend", 180);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("内部滚动容器未到顶时不接管手势（不误触发下拉刷新）", async () => {
    const onRefresh = vi.fn();
    const scroll = <div data-ptr-scroll="" style={{}} />;
    const el = render(onRefresh, scroll);
    const scroller = el.querySelector<HTMLElement>("[data-ptr-scroll]")!;
    Object.defineProperty(scroller, "scrollTop", { value: 120, configurable: true });
    const ptr = el.querySelector(".ptr")!;

    touch(ptr, "touchstart", 100);
    for (let y = 120; y <= 320; y += 40) touch(ptr, "touchmove", y);
    await flushRaf();
    touch(ptr, "touchend", 320);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
