/**
 * HostRequestCard（hub 驱动接管的手机批权限卡片）：
 * 渲染标题/详情折叠、允许/拒绝回调、应答中禁用、超时灰显。
 */
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { HostRequestCard } from "./HostRequestCard";
import type { HostRequestDto } from "../api/types";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const request: HostRequestDto = {
  id: "call_1",
  sessionId: "s1",
  kind: "permission",
  title: "Bash: rm -rf build",
  detail: '{"command":"rm -rf build"}',
  toolName: "Bash",
  allowAlways: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

async function render(props: Partial<React.ComponentProps<typeof HostRequestCard>> = {}) {
  const onRespond = props.onRespond ?? vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <HostRequestCard request={props.request ?? request} respondingId={props.respondingId ?? null} onRespond={onRespond} />,
    );
  });
  return { container, onRespond, unmount: () => root.unmount() };
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("HostRequestCard", () => {
  it("渲染标题与工具入参，点允许/拒绝触发回调", async () => {
    const { container, onRespond, unmount } = await render();
    expect(container.textContent).toContain("需要你批准");
    expect(container.textContent).toContain("Bash: rm -rf build");

    click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "允许") ?? null);
    expect(onRespond).toHaveBeenCalledWith("call_1", "allow");
    click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "拒绝") ?? null);
    expect(onRespond).toHaveBeenCalledWith("call_1", "deny");
    unmount();
  });

  it("详情折叠展开/收起", async () => {
    const { container, unmount } = await render();
    expect(container.querySelector(".host-request-detail")).toBeNull();
    click(container.querySelector(".host-request-detail-toggle"));
    expect(container.querySelector(".host-request-detail")?.textContent).toContain("rm -rf build");
    click(container.querySelector(".host-request-detail-toggle"));
    expect(container.querySelector(".host-request-detail")).toBeNull();
    unmount();
  });

  it("应答中（respondingId 命中）按钮禁用", async () => {
    const { container, unmount } = await render({ respondingId: "call_1" });
    const allow = container.querySelector<HTMLButtonElement>(".host-request-btn.allow");
    expect(allow).not.toBeNull();
    expect(allow!.disabled).toBe(true);
    expect(container.textContent).toContain("提交中");
    unmount();
  });

  it("已过期：灰显 + 禁用 + 提示（服务端自动拒绝）", async () => {
    const expired: HostRequestDto = { ...request, expiresAt: Date.now() - 1000 };
    const { container, onRespond, unmount } = await render({ request: expired });
    expect(container.querySelector(".host-request.expired")).not.toBeNull();
    expect(container.textContent).toContain("自动拒绝");
    const allow = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("允许"));
    click(allow ?? null);
    expect(onRespond).not.toHaveBeenCalled();
    unmount();
  });
});
