/**
 * 发送模式收纳（反馈轮 3 #3）：
 * 1. 触发按钮显示当前模式短标签，点开弹出选择面板（含每个模式一句话说明）
 * 2. 选中即回调 onChange 并收起；功能语义 auto/prompt/steer/followUp 全保留
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_MODE_OPTIONS, SendModeMenu } from "./SendModeMenu";

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

describe("SendModeMenu 发送模式收纳", () => {
  it("默认收起为一个小图标按钮（显示当前模式短标签）", () => {
    const el = render(<SendModeMenu value="auto" onChange={() => {}} />);
    const trigger = el.querySelector<HTMLButtonElement>(".mode-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("⚡ 自动");
    expect(el.querySelector(".mode-menu")).toBeNull();
  });

  it("点开弹出模式选择：4 个模式全保留 + 每项一句话说明", () => {
    const el = render(<SendModeMenu value="auto" onChange={() => {}} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".mode-trigger")!.click();
    });
    const items = el.querySelectorAll(".mode-menu-item");
    expect(items).toHaveLength(SEND_MODE_OPTIONS.length);
    const keys = SEND_MODE_OPTIONS.map((o) => o.key);
    expect(keys).toEqual(["auto", "prompt", "steer", "followUp"]);
    for (const item of items) {
      expect(item.querySelector(".mode-menu-hint")?.textContent ?? "").not.toBe("");
    }
    // 当前模式高亮
    expect(el.querySelector(".mode-menu-item.active .mode-menu-label")?.textContent).toBe("⚡ 自动");
  });

  it("选中模式回调 onChange(mode) 并收起弹层（受控回显随 value）", () => {
    // 受控包装器：验证选中后触发按钮回显新模式
    function Controlled() {
      const [mode, setMode] = useState<import("../api/prompt").SendMode>("auto");
      return <SendModeMenu value={mode} onChange={setMode} />;
    }
    const onChange = vi.fn();
    const el = render(
      <>
        <Controlled />
      </>,
    );
    act(() => {
      el.querySelector<HTMLButtonElement>(".mode-trigger")!.click();
    });
    const items = el.querySelectorAll<HTMLButtonElement>(".mode-menu-item");
    act(() => {
      items[2].click(); // steer
    });
    expect(el.querySelector(".mode-menu")).toBeNull();
    // 触发按钮回显所选模式
    expect(el.querySelector(".mode-trigger")?.textContent).toContain("✋ 插话");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("受控 value 不变时不自变（onChange 是唯一变更通道）", () => {
    const onChange = vi.fn();
    const el = render(<SendModeMenu value="auto" onChange={onChange} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".mode-trigger")!.click();
    });
    const items = el.querySelectorAll<HTMLButtonElement>(".mode-menu-item");
    act(() => {
      items[2].click();
    });
    expect(onChange).toHaveBeenCalledWith("steer");
    expect(el.querySelector(".mode-trigger")?.textContent).toContain("⚡ 自动");
  });
});
