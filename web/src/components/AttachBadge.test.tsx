/**
 * 会话列表驱动方式徽章（E3）测试：三态文案 / emoji + 短标签、无状态不渲染、窄屏语义保留（title）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AttachBadge } from "./AttachBadge";

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

describe("AttachBadge", () => {
  it("三态徽章：🖥⚡ 已接管 / 🖥 终端在线 / 📱 平行线（title 保留完整语义）", () => {
    const attached = render(<AttachBadge terminal={{ online: true, attached: true }} />);
    expect(attached.textContent).toContain("🖥⚡");
    expect(attached.textContent).toContain("已接管");
    expect(attached.querySelector(".badge")!.getAttribute("title")).toMatch(/已接管/);

    const online = render(<AttachBadge terminal={{ online: true, attached: false }} />);
    expect(online.textContent).toContain("终端在线");

    const parallel = render(<AttachBadge terminal={{ online: false, attached: false }} />);
    expect(parallel.textContent).toContain("平行线");
  });

  it("无 terminal 状态（claude / 旧 server）不渲染", () => {
    const el = render(<AttachBadge terminal={null} />);
    expect(el.querySelector(".badge")).toBeNull();
  });
});
