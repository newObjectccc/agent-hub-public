/**
 * 发送归属状态条（E3）测试：一行小字确认归属；无内容零占位；失败态样式。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelEcho } from "./ChannelEcho";

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
});

describe("ChannelEcho", () => {
  it("attach 发送后显示「已发往终端」；接收确认后显示「终端已接收」", () => {
    const sent = render(<ChannelEcho echo={{ channel: "attach", phase: "sent" }} />);
    expect(sent.querySelector(".channel-echo")!.textContent).toMatch(/已发往终端/);
    const acked = render(<ChannelEcho echo={{ channel: "attach", phase: "acked" }} />);
    expect(acked.querySelector(".channel-echo")!.textContent).toMatch(/终端已接收/);
  });

  it("parallel 显示「平行线工作中」；失败态带 .failed 类与原因", () => {
    const parallel = render(<ChannelEcho echo={{ channel: "parallel", phase: "working" }} />);
    expect(parallel.querySelector(".channel-echo")!.textContent).toMatch(/平行线工作中/);
    const failed = render(<ChannelEcho echo={{ channel: "attach", phase: "failed", detail: "终端正忙" }} />);
    expect(failed.querySelector(".channel-echo.failed")!.textContent).toMatch(/终端正忙/);
  });

  it("无状态零占位（不渲染任何节点）", () => {
    const el = render(<ChannelEcho echo={null} />);
    expect(el.querySelector(".channel-echo")).toBeNull();
    expect(el.textContent).toBe("");
  });
});
