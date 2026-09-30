/**
 * 发送失败标记 + 重试按钮（user 气泡尾部）：失败显示「⚠️ 发送失败」，点击重发同样内容。
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
  id: "local-1",
  role: "user",
  timestamp: 1000,
  text: "你好",
  toolCalls: [],
};

describe("MessageBubble 发送失败重试", () => {
  it("sendFailed：显示「⚠️ 发送失败」+ 重试按钮，点击触发 onRetry", () => {
    const onRetry = vi.fn();
    const el = render(<MessageBubble message={userMessage} sendFailed onRetry={onRetry} />);
    expect(el.querySelector(".send-failed")).not.toBeNull();
    expect(el.textContent).toContain("发送失败");
    const btn = el.querySelector<HTMLButtonElement>(".send-retry")!;
    expect(btn.textContent).toBe("重试");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("未失败/assistant 消息不渲染失败条", () => {
    const ok = render(<MessageBubble message={userMessage} onRetry={() => {}} />);
    expect(ok.querySelector(".send-failed")).toBeNull();
    const assistant = render(
      <MessageBubble message={{ ...userMessage, id: "a1", role: "assistant" }} sendFailed onRetry={() => {}} />,
    );
    expect(assistant.querySelector(".send-failed")).toBeNull();
  });

  it("320 紧凑：重试按钮带热区外扩 ::after 挂钩类名（.send-retry）", () => {
    const el = render(<MessageBubble message={userMessage} sendFailed onRetry={() => {}} />);
    expect(el.querySelector("button.send-retry")).not.toBeNull();
  });
});
