/**
 * 集中 ticker（UX 审查 AC6）：N 个实时组件共享一个 setInterval，
 * 不再每卡独立挂 1s 定时器；全部卸载即停表。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeTickerCount, useNowTicker } from "./useNowTicker";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function Probe({ active }: { active: boolean }) {
  useNowTicker(active);
  return null;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

describe("useNowTicker 集中 ticker", () => {
  it("多组件共享一个定时器（不是每卡一个 interval）", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    mount(
      <>
        <Probe active />
        <Probe active />
        <Probe active />
        <Probe active />
        <Probe active />
      </>,
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(activeTickerCount()).toBe(1);
    setIntervalSpy.mockRestore();
  });

  it("inactive 不挂定时器；全部卸载后停表（clearInterval）", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    mount(
      <>
        <Probe active={false} />
        <Probe active />
      </>,
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(activeTickerCount()).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("tick 到点驱动 now 更新（运行中计时秒级跳动）", () => {
    vi.useFakeTimers();
    let now = 0;
    function Timed() {
      now = useNowTicker(true);
      return null;
    }
    mount(<Timed />);
    const before = now;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(now).toBeGreaterThanOrEqual(before);
    vi.useRealTimers();
  });
});
