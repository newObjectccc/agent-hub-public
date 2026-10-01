/**
 * MessageBubble 离线队列标记（F1）：失败条上的「📶 等待发送」融合标记。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../api/types";
import { MessageBubble } from "./MessageBubble";

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

const userMessage: SessionMessage = {
  id: "local-q1",
  role: "user",
  timestamp: 1000,
  text: "断网消息",
  toolCalls: [],
};

describe("MessageBubble 离线队列标记", () => {
  it("sendQueued：失败条上追加「📶 等待发送」，保留 ⚠️ 发送失败 + 重试", () => {
    const onRetry = vi.fn();
    const el = render(<MessageBubble message={userMessage} sendFailed sendQueued onRetry={onRetry} />);
    expect(el.querySelector(".send-failed")).not.toBeNull();
    expect(el.textContent).toContain("发送失败");
    expect(el.querySelector(".send-queued-tag")).not.toBeNull();
    expect(el.textContent).toContain("等待发送");
    const btn = el.querySelector<HTMLButtonElement>(".send-retry")!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("仅 sendFailed（业务拒绝手动重试）：不显示 📶 标记", () => {
    const el = render(<MessageBubble message={userMessage} sendFailed onRetry={() => {}} />);
    expect(el.querySelector(".send-queued-tag")).toBeNull();
  });
});
