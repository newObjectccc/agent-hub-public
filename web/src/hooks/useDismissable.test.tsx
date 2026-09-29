/**
 * useDismissable 单测：点外部/触屏/Escape 关闭、锚点不误关、弹层互斥。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDismissable } from "./useDismissable";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Layer({ id, withAnchor = false }: { id: string; withAnchor?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  useDismissable({
    open,
    onDismiss: () => setOpen(false),
    rootRef,
    anchorRefs: withAnchor ? [anchorRef] : [],
  });
  return (
    <div>
      <button type="button" className={`${id}-trigger`} ref={withAnchor ? anchorRef : undefined} onClick={() => setOpen((v) => !v)}>
        toggle {id}
      </button>
      <div ref={rootRef}>{open && <div className={`${id}-panel`}>{id} 面板</div>}</div>
    </div>
  );
}

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

function fire(el: Element | null, type: string): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
}

function openPanel(el: HTMLElement, id: string): void {
  fire(el.querySelector(`.${id}-trigger`), "click");
  expect(el.querySelector(`.${id}-panel`)).not.toBeNull();
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("useDismissable：外部关闭", () => {
  it("点击外部（click/pointerdown）关闭面板", () => {
    const el = render(<Layer id="a" />);
    openPanel(el, "a");
    fire(document.body, "pointerdown");
    fire(document.body, "click");
    expect(el.querySelector(".a-panel")).toBeNull();
  });

  it("触屏 touchend 在外部也关闭（移动端 tap 兼容）", () => {
    const el = render(<Layer id="a" />);
    openPanel(el, "a");
    fire(document.body, "touchend");
    expect(el.querySelector(".a-panel")).toBeNull();
  });

  it("Escape 关闭", () => {
    const el = render(<Layer id="a" />);
    openPanel(el, "a");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector(".a-panel")).toBeNull();
  });

  it("面板内部点击不关闭；锚点（触发按钮）点击不误关", () => {
    const el = render(<Layer id="a" withAnchor />);
    openPanel(el, "a");
    fire(el.querySelector(".a-panel"), "pointerdown");
    expect(el.querySelector(".a-panel")).not.toBeNull();
    // 锚点上点击：toggle 自身负责开关，外部逻辑不得先关掉（“打开即被关”打架）
    fire(el.querySelector(".a-trigger"), "pointerdown");
    expect(el.querySelector(".a-panel")).not.toBeNull();
  });
});

describe("useDismissable：弹层互斥", () => {
  it("打开第二个弹层时第一个自动关闭（同屏只开一个）", () => {
    const el = render(
      <div>
        <Layer id="a" />
        <Layer id="b" />
      </div>,
    );
    openPanel(el, "a");
    openPanel(el, "b");
    expect(el.querySelector(".a-panel")).toBeNull();
    expect(el.querySelector(".b-panel")).not.toBeNull();
  });

  it("点击另一弹层的触发按钮：旧的关、新的开（不残留双开）", () => {
    const el = render(
      <div>
        <Layer id="a" />
        <Layer id="b" />
      </div>,
    );
    openPanel(el, "a");
    fire(el.querySelector(".b-trigger"), "pointerdown");
    fire(el.querySelector(".b-trigger"), "click");
    expect(el.querySelector(".a-panel")).toBeNull();
    expect(el.querySelector(".b-panel")).not.toBeNull();
  });
});
