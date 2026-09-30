/**
 * 双模式切换徽章（E3）测试：顶栏紧凑触发器、菜单二选一、
 * 接管不可用灰显 + 原因、选中回调与菜单收起。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachModeMenu } from "./AttachModeMenu";

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

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("AttachModeMenu", () => {
  it("触发徽章按当前模式显示（📱 平行 / 🖥 接管），默认收起", () => {
    const el = render(<AttachModeMenu mode="parallel" terminal={null} onChange={() => undefined} />);
    expect(el.querySelector(".attach-trigger")!.textContent).toContain("📱 平行");
    expect(el.querySelector(".attach-menu")).toBeNull();
  });

  it("点开菜单两项带一句话说明；选「接管终端」触发 onChange 且收起", () => {
    const onChange = vi.fn();
    const el = render(
      <AttachModeMenu mode="parallel" terminal={{ online: true, attached: false }} onChange={onChange} />,
    );
    click(el.querySelector(".attach-trigger"));
    const items = el.querySelectorAll('[role="menuitemradio"]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("📱 平行继续");
    expect(items[1].textContent).toContain("🖥 接管终端");
    expect(items[0].textContent).toMatch(/server/);
    expect(items[1].textContent).toMatch(/终端实时显示/);

    click(items[1]);
    expect(onChange).toHaveBeenCalledWith("attach");
    expect(el.querySelector(".attach-menu")).toBeNull();
  });

  it("接管不可用（终端离线）：接管项灰显 + 原因，点击无效", () => {
    const onChange = vi.fn();
    const el = render(<AttachModeMenu mode="parallel" terminal={{ online: false, attached: false }} onChange={onChange} />);
    click(el.querySelector(".attach-trigger"));
    const attachItem = el.querySelectorAll('[role="menuitemradio"]')[1] as HTMLElement;
    expect(attachItem.classList.contains("disabled")).toBe(true);
    expect(attachItem.getAttribute("aria-disabled")).toBe("true");
    expect(attachItem.textContent).toMatch(/终端 pi 不在线/);
    click(attachItem);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("attach 模式触发徽章显示 🖥 接管；切回平行触发 onChange('parallel')", () => {
    const onChange = vi.fn();
    const el = render(
      <AttachModeMenu mode="attach" terminal={{ online: true, attached: true }} onChange={onChange} />,
    );
    expect(el.querySelector(".attach-trigger")!.textContent).toContain("🖥 接管");
    click(el.querySelector(".attach-trigger"));
    click(el.querySelectorAll('[role="menuitemradio"]')[0]);
    expect(onChange).toHaveBeenCalledWith("parallel");
  });
});
