/**
 * 顶层 ErrorBoundary（首屏可靠性 #5）：React 渲染异常不黑屏——
 * 友好错误卡（role=alert）+「重试」（重置边界重新渲染）+「刷新页面」（location.reload）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

/** 可控抛错子组件：fail=true 渲染即抛（模拟渲染崩溃） */
function Boom({ fail }: { fail: boolean }): React.ReactElement {
  if (fail) throw new Error("boom");
  return <div>ok-content</div>;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("ErrorBoundary 顶层渲染兜底", () => {
  it("子组件抛错 → 显示友好错误卡（非黑屏），带重试/刷新按钮", () => {
    // React 自身的错误报告噪音静音，但不吞应用层日志
    vi.spyOn(console, "error").mockImplementation(() => {});

    const el = render(
      <ErrorBoundary>
        <Boom fail />
      </ErrorBoundary>,
    );

    expect(el.textContent).not.toContain("ok-content");
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("页面出错了");
    expect(alert!.textContent).toContain("应用渲染时发生异常，请重试或刷新页面。");
    const buttons = [...alert!.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("重试");
    expect(buttons).toContain("刷新页面");
  });

  it("componentDidCatch 记录排查线索（console.error 带「渲染异常」与组件栈）", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom fail />
      </ErrorBoundary>,
    );

    const appLog = consoleSpy.mock.calls.find((args) => String(args[0]).includes("渲染异常"));
    expect(appLog).toBeDefined();
    expect(String(appLog![1])).toContain("boom");
  });

  it("「重试」重置边界重新渲染：仍失败留在错误卡，恢复后回到正常内容", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const el = render(
      <ErrorBoundary>
        <Boom fail />
      </ErrorBoundary>,
    );
    const retryBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "重试")!;

    // 仍失败：重试后再次落回错误卡（不白屏不崩）
    act(() => {
      retryBtn.click();
    });
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.textContent).not.toContain("ok-content");

    // 故障消失后重试：正常内容回来
    rerender(
      <ErrorBoundary>
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    const retryAgain = [...el.querySelectorAll("button")].find((b) => b.textContent === "重试")!;
    act(() => {
      retryAgain.click();
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("ok-content");
  });

  it("「刷新页面」触发 onReload（默认 location.reload）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReload = vi.fn();

    const el = render(
      <ErrorBoundary onReload={onReload}>
        <Boom fail />
      </ErrorBoundary>,
    );
    const reloadBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "刷新页面")!;

    act(() => {
      reloadBtn.click();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("无错误时原样渲染 children", () => {
    const el = render(
      <ErrorBoundary>
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    expect(el.textContent).toContain("ok-content");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});
