/**
 * 工具卡执行时长 + 「运行中」脉冲（reduced-motion 由 CSS 降级，此处验证结构挂钩类名）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../api/types";
import { ToolCallCard } from "./ToolCallCard";

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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function tool(over: Partial<ToolCall> = {}): ToolCall {
  return { name: "bash", summary: "ls -la", status: "done", resultPreview: null, ...over };
}

describe("ToolCallCard 执行时长", () => {
  it("running 卡：.running 脉冲挂钩 + ⏱ 已运行时长秒级跳动", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const el = render(<ToolCallCard toolCall={tool({ status: "running", startedAt: 100_000 })} />);
    expect(el.querySelector(".tool-card.running")).not.toBeNull();
    expect(el.querySelector(".tool-duration.running")!.textContent).toBe("⏱ 0s");
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(el.querySelector(".tool-duration")!.textContent).toBe("⏱ 12s");
  });

  it("done 卡：显示总耗时（endedAt - startedAt），无脉冲", () => {
    const el = render(<ToolCallCard toolCall={tool({ startedAt: 1_000, endedAt: 31_000 })} />);
    expect(el.querySelector(".tool-card.running")).toBeNull();
    expect(el.querySelector(".tool-duration")!.textContent).toBe("耗时 30s");
    expect(el.querySelector(".tool-duration.running")).toBeNull();
  });

  it("无打点（历史消息/老数据）不渲染时长", () => {
    const el = render(<ToolCallCard toolCall={tool()} />);
    expect(el.querySelector(".tool-duration")).toBeNull();
  });
});
