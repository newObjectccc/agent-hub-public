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
  it("触发器纯图标不带文字（手机图形/终端显示器区分），语义在 aria-label/title", () => {
    const el = render(<AttachModeMenu mode="parallel" terminal={null} onChange={() => undefined} />);
    const trigger = el.querySelector(".attach-trigger")!;
    // J1 图标化：可见文字为零（窄屏文字看不清的根治），只留图标 + 下拉箭头
    expect(trigger.textContent!.trim()).toBe("");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("平行继续");
    expect(trigger.getAttribute("title")).toContain("平行继续");
    expect(el.querySelector(".attach-menu")).toBeNull();
  });

  it("attach 模式触发器图标切为终端显示器；aria-label 带「接管终端」", () => {
    const onChange = vi.fn();
    const el = render(
      <AttachModeMenu mode="attach" terminal={{ online: true, attached: true }} onChange={onChange} />,
    );
    const trigger = el.querySelector(".attach-trigger")!;
    expect(trigger.textContent!.trim()).toBe("");
    expect(trigger.getAttribute("aria-label")).toContain("接管终端");
  });

  it("点开菜单两项带一句话说明；选「接管终端」触发 onChange 且收起", () => {
    const onChange = vi.fn();
    const el = render(
      <AttachModeMenu mode="parallel" terminal={{ online: true, attached: false }} onChange={onChange} />,
    );
    click(el.querySelector(".attach-trigger"));
    const items = el.querySelectorAll('[role="menuitemradio"]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("平行继续");
    expect(items[1].textContent).toContain("接管终端");
    expect(items[0].textContent).toMatch(/server/);
    expect(items[1].textContent).toMatch(/终端实时显示/);

    click(items[1]);
    expect(onChange).toHaveBeenCalledWith("attach");
    expect(el.querySelector(".attach-menu")).toBeNull();
  });

  it("菜单两项文字前各自 icon（终端显示器 vs 手机图形），说明文字保留", () => {
    const el = render(
      <AttachModeMenu mode="parallel" terminal={{ online: true, attached: false }} onChange={() => undefined} />,
    );
    click(el.querySelector(".attach-trigger"));
    const items = el.querySelectorAll('[role="menuitemradio"]');
    // 每项 label 内 icon 在文字前（.attach-menu-icon 是 label 的第一个子节点）
    for (const item of items) {
      const label = item.querySelector(".attach-menu-label")!;
      expect(label.querySelector(".attach-menu-icon svg")).not.toBeNull();
      expect(label.firstElementChild!.classList.contains("attach-menu-icon")).toBe(true);
    }
    // 两项图形不同：手机图形（平行）vs 终端显示器（接管），可视觉区分
    const parallelSvg = items[0].querySelector(".attach-menu-icon svg")!;
    const attachSvg = items[1].querySelector(".attach-menu-icon svg")!;
    expect(parallelSvg.innerHTML).not.toBe(attachSvg.innerHTML);
    // 说明文字保留
    expect(items[0].querySelector(".attach-menu-hint")!.textContent).toMatch(/server/);
    expect(items[1].querySelector(".attach-menu-hint")!.textContent).toMatch(/终端实时显示/);
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

  it("attach 模式切回平行触发 onChange('parallel')（触发器已纯图标）", () => {
    const onChange = vi.fn();
    const el = render(
      <AttachModeMenu mode="attach" terminal={{ online: true, attached: true }} onChange={onChange} />,
    );
    expect(el.querySelector(".attach-trigger")!.getAttribute("aria-label")).toContain("接管终端");
    click(el.querySelector(".attach-trigger"));
    click(el.querySelectorAll('[role="menuitemradio"]')[0]);
    expect(onChange).toHaveBeenCalledWith("parallel");
  });
});
