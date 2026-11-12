/**
 * 消息复制/选字交互（手机端复制痛点修复）：
 * 1. 脚部复制图标一触即复制 message.text（markdown 源文口径）+ toast；流式消息标注截断语义
 * 2. 部分文字：触屏文本区长按/右键放行系统选词（绝不 preventDefault），选字手势尾随 click 被吞
 * 3. 长按菜单（进阶）：脚部长按 / ⋯ 按钮 / 桌面右键开菜单；「复制所选（N 字）」只在有选区时出现
 * 4. 图片例外：长按/右键不拦截（Android 原生"保存图片"）
 * 5. 长按触发后的尾随 click 不误触（工具卡/按钮）
 *
 * 回归背景：旧实现把长按劫持给自定义菜单 + onContextMenu preventDefault 抑制系统 callout，
 * "复制消息里的部分文字"实质不可用、"复制整条"要 长按→菜单→点击 三步。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../api/types";
import { dismissToast, getToasts } from "../utils/toast";
import {
  COPY_FAIL_TOAST,
  COPY_SELECTION_TOAST,
  COPY_SUCCESS_TOAST,
  MessageBubble,
} from "./MessageBubble";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let writeText: ReturnType<typeof vi.fn>;
let clipboardOk = true;

/** matchMedia 桩：pointer fine/coarse 两分支可切（jsdom 无 matchMedia） */
let finePointer = false;
function stubMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("pointer: fine") ? finePointer : query.includes("pointer: coarse") ? !finePointer : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

/** 选区桩：可设文本与锚点 */
let selectionText = "";
let selectionNode: Node | null = null;
function stubSelection(): void {
  vi.stubGlobal("getSelection", () => ({
    toString: () => selectionText,
    isCollapsed: selectionText === "",
    rangeCount: selectionText === "" ? 0 : 1,
    anchorNode: selectionNode,
    focusNode: selectionNode,
    removeAllRanges: () => undefined,
    addRange: () => undefined,
  }));
}

function message(over: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    timestamp: 1,
    text: "你好，**世界**",
    thinking: null,
    toolCalls: [],
    ...over,
  };
}


/** jsdom 无 PointerEvent 构造器：MouseEvent + 指定 type 等效派发（监听按 type 匹配） */
function pe(type: string, x = 0, y = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

/** 真实 tap 手势 = pointerdown + click 成对（trailingClick 的新手势解除武装依赖 pointerdown 先行） */
function tap(el: Element): void {
  el.dispatchEvent(pe("pointerdown"));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

function render(msg: SessionMessage, props: Record<string, unknown> = {}): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MessageBubble message={msg} onQuote={() => undefined} {...props} />);
  });
  return container;
}

function pressFoot(el: HTMLElement): HTMLElement {
  const foot = el.querySelector<HTMLElement>(".msg-foot")!;
  act(() => {
    foot.dispatchEvent(pe("pointerdown", 10, 10));
  });
  return foot;
}

function releaseFoot(foot: HTMLElement): void {
  act(() => {
    foot.dispatchEvent(pe("pointerup", 10, 10));
  });
}

function longPressFoot(el: HTMLElement): void {
  const foot = pressFoot(el);
  act(() => {
    vi.advanceTimersByTime(600); // LONG_PRESS_DELAY_MS = 500
  });
  releaseFoot(foot);
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn(async () => {
    if (!clipboardOk) throw new Error("denied");
  });
  clipboardOk = true;
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  finePointer = false;
  selectionText = "";
  selectionNode = null;
  stubMatchMedia();
  stubSelection();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  // 解除 trailingClick 模块单例的残余武装（防跨用例吞 click）
  document.dispatchEvent(pe("pointerdown"));
  container?.remove();
  root = null;
  container = null;
  for (const t of getToasts()) dismissToast(t.id);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("脚部复制图标：一触即复制整条", () => {
  it("点击复制图标 → 复制 message.text（markdown 源文）+ 成功 toast；不弹菜单", async () => {
    const el = render(message());
    const btn = el.querySelector<HTMLButtonElement>(".msg-copy-btn")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(writeText).toHaveBeenCalledWith("你好，**世界**");
    expect(getToasts().some((t) => t.text === COPY_SUCCESS_TOAST)).toBe(true);
    expect(el.querySelector(".msg-menu")).toBeNull();
  });

  it("writeText 在用户手势链内同步起步（调用前不得 await；契约：iOS 手势约束）", () => {
    const el = render(message());
    const btn = el.querySelector<HTMLButtonElement>(".msg-copy-btn")!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    // 同步断言（不 await）：此处 writeText 必须已被调用——插入任何 await 都会令本断言失败
    expect(writeText).toHaveBeenCalledWith("你好，**世界**");
  });

  it("旧选区残留时慢点按钮（按住 ≥400ms）不吞自身 click（按钮不假死）", async () => {
    // 回归：选词手势判定不得误伤慢点——只在"本手势期间选区从无到有"时吞尾随 click
    const el = render(message());
    selectionText = "残留的旧选区";
    selectionNode = el.querySelector(".bubble")!;
    const btn = el.querySelector<HTMLButtonElement>(".msg-copy-btn")!;
    act(() => {
      btn.dispatchEvent(pe("pointerdown", 10, 10));
    });
    act(() => {
      vi.advanceTimersByTime(450); // ≥400ms 但 <500ms（不触发长按菜单）
      btn.dispatchEvent(pe("pointerup", 10, 10));
    });
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    // click 未被吞 → handleCopy 执行
    expect(writeText).toHaveBeenCalledWith("你好，**世界**");
    expect(getToasts().some((t) => t.text === COPY_SUCCESS_TOAST)).toBe(true);
  });

  it("流式消息复制按钮标注「复制当前已生成文本」（截断语义显式化）", () => {
    const el = render(message({ streaming: true }));
    const btn = el.querySelector<HTMLButtonElement>(".msg-copy-btn")!;
    expect(btn.getAttribute("aria-label")).toBe("复制当前已生成文本");
    expect(btn.getAttribute("title")).toBe("复制当前已生成文本");
  });

  it("复制失败 → 失败 toast（降级链路见 clipboard.test.ts）", async () => {
    clipboardOk = false;
    const el = render(message());
    await act(async () => {
      el.querySelector<HTMLButtonElement>(".msg-copy-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(getToasts().some((t) => t.text === COPY_FAIL_TOAST)).toBe(true);
    expect(getToasts().some((t) => t.text === COPY_SUCCESS_TOAST)).toBe(false);
  });

  it("无文本消息（纯图片）不渲染复制/更多按钮", () => {
    const el = render(message({ text: "", images: [{ url: "https://x.test/a.png", alt: "图" }] }));
    expect(el.querySelector(".msg-copy-btn")).toBeNull();
    expect(el.querySelector(".msg-more-btn")).toBeNull();
  });
});

describe("长按菜单：脚部长按 / ⋯ 按钮 / 桌面右键", () => {
  it("脚部长按 500ms 开菜单（含 复制文本/全选/引用/关闭）", () => {
    const el = render(message());
    longPressFoot(el);
    const menu = el.querySelector(".msg-menu");
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll(".msg-menu-item")).map((b) => b.textContent!.replace(/（\d+ 字）/, ""));
    expect(items).toContain("复制文本");
    expect(items).toContain("全选");
    expect(items).toContain("引用");
    expect(items).toContain("关闭");
  });

  it("⋯ 按钮点击开菜单；菜单项「复制文本」复制 message.text", async () => {
    const el = render(message());
    act(() => {
      el.querySelector<HTMLButtonElement>(".msg-more-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(el.querySelector(".msg-menu")).not.toBeNull();
    const copyItem = Array.from(el.querySelectorAll<HTMLButtonElement>(".msg-menu-item")).find((b) =>
      b.textContent?.includes("复制文本"),
    )!;
    await act(async () => {
      copyItem.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(writeText).toHaveBeenCalledWith("你好，**世界**");
    expect(getToasts().some((t) => t.text === COPY_SUCCESS_TOAST)).toBe(true);
  });

  it("菜单定位：按压点锚定经 offset*/gBCR 换算写入 style.left/top（滚动容器裁剪 clamp）", () => {
    const el = render(message());
    // 桩布局尺寸：菜单 100x50、body 在视口 (0, 300)、滚动容器可见区 [300, 500]
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(50);
    const body = el.querySelector<HTMLElement>(".msg-body")!;
    const host: HTMLElement = container!;
    host.classList.add("chat-messages"); // closest(".chat-messages") 命中（不搬动 React 树节点）
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 300, top: 300, left: 0, bottom: 800, right: 320, width: 320, height: 500, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 300, top: 300, left: 0, bottom: 500, right: 320, width: 320, height: 200, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);

    // 锚点 (160, 480)：中心放下 top=455，bottom=505 > 容器底 500-8 → 上翻到锚点上方
    const btn = el.querySelector<HTMLButtonElement>(".msg-more-btn")!;
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({
      x: 150, y: 470, top: 470, left: 150, bottom: 498, right: 178, width: 28, height: 28, toJSON: () => ({}),
    } as DOMRect);
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    const menu = el.querySelector<HTMLElement>(".msg-menu")!;
    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    // body 原点 (0, 300)：换算后 = 视口坐标 - body 偏移
    expect(left).toBeCloseTo(150 + 14 - 50, 0); // 按钮中心 (164) 锚定，menu 宽 100 → left=114
    expect(top + 300 + 50).toBeLessThanOrEqual(492); // 上翻后不越容器底（含 margin）
    expect(top + 300).toBeGreaterThanOrEqual(300); // 不越容器顶
  });

  it("「复制所选（N 字）」仅在有选区时出现；点击复制选区文本", async () => {
    const el = render(message());
    // 无选区：不出现
    act(() => {
      el.querySelector<HTMLButtonElement>(".msg-more-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(el.querySelector(".msg-menu")!.textContent).not.toContain("复制所选");
    // 关菜单
    act(() => {
      document.dispatchEvent(pe("pointerdown"));
    });

    // 有选区：出现且带字数；点击复制选区（tap 成对手势：关菜单那一击的武装由本次 pointerdown 解除）
    selectionText = "选中的文字";
    selectionNode = el.querySelector(".bubble")!;
    act(() => {
      tap(el.querySelector<HTMLButtonElement>(".msg-more-btn")!);
    });
    const menu = el.querySelector(".msg-menu")!;
    expect(menu.textContent).toContain("复制所选（5 字）");
    const selItem = Array.from(menu.querySelectorAll<HTMLButtonElement>(".msg-menu-item")).find((b) =>
      b.textContent?.includes("复制所选"),
    )!;
    await act(async () => {
      selItem.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(writeText).toHaveBeenCalledWith("选中的文字");
    expect(getToasts().some((t) => t.text === COPY_SELECTION_TOAST)).toBe(true);
  });

  it("菜单「全选」：Range 选中 .bubble 渲染内容（渲染纯文本口径）", () => {
    const el = render(message());
    const bubble = el.querySelector(".bubble")!;
    selectionNode = bubble;
    act(() => {
      el.querySelector<HTMLButtonElement>(".msg-more-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    const selectAll = Array.from(el.querySelectorAll<HTMLButtonElement>(".msg-menu-item")).find((b) =>
      b.textContent?.includes("全选"),
    )!;
    const addRange = vi.fn();
    const removeAllRanges = vi.fn();
    vi.stubGlobal("getSelection", () => ({
      toString: () => selectionText,
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
      removeAllRanges,
      addRange,
    }));
    act(() => {
      selectAll.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(removeAllRanges).toHaveBeenCalled();
    expect(addRange).toHaveBeenCalledTimes(1);
    // Range 必须真正覆盖 .bubble 渲染内容（"所见即所选"契约，防被无声改坏）
    const range = addRange.mock.calls[0][0] as Range;
    const covers = range.commonAncestorContainer === bubble || bubble.contains(range.commonAncestorContainer);
    expect(covers).toBe(true);
    expect(el.querySelector(".msg-menu")).toBeNull(); // 操作后关菜单
  });
});

describe("部分文字：触屏选字放行（不再劫持长按/contextmenu）", () => {
  it("触屏（coarse）文本区 contextmenu 不 preventDefault（系统选词 callout 出得来）", () => {
    const el = render(message());
    const text = el.querySelector(".bubble > span") ?? el.querySelector(".bubble")!;
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    act(() => {
      text.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(el.querySelector(".msg-menu")).toBeNull();
  });

  it("触屏文本区长按 500ms 不弹自定义菜单（手势留给系统选词）", () => {
    const el = render(message());
    const bubble = el.querySelector(".bubble")!;
    act(() => {
      bubble.dispatchEvent(pe("pointerdown", 5, 5));
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(el.querySelector(".msg-menu")).toBeNull();
  });

  it("选词手势（长按 ≥400ms + 抬手有选区）收尾的尾随 click 被吞（不误触按钮）", () => {
    const el = render(message());
    const bubble = el.querySelector(".bubble")!;
    let clicked = 0;
    bubble.addEventListener("click", () => {
      clicked += 1;
    });
    act(() => {
      bubble.dispatchEvent(pe("pointerdown", 5, 5));
    });
    // 长按期间系统选词形成
    selectionText = "被选中的词";
    selectionNode = bubble;
    act(() => {
      vi.advanceTimersByTime(500);
      bubble.dispatchEvent(pe("pointerup", 5, 5));
    });
    // 内核补发的尾随 click
    act(() => {
      bubble.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(clicked).toBe(0); // 被吞
  });

  it("短按（<400ms）后的 click 正常放行（不影响工具卡/按钮点击）", () => {
    const el = render(message());
    const bubble = el.querySelector(".bubble")!;
    let clicked = 0;
    bubble.addEventListener("click", () => {
      clicked += 1;
    });
    act(() => {
      bubble.dispatchEvent(pe("pointerdown", 5, 5));
    });
    act(() => {
      vi.advanceTimersByTime(50);
      bubble.dispatchEvent(pe("pointerup", 5, 5));
      bubble.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(clicked).toBe(1);
  });
});

describe("桌面（fine）右键：自定义菜单；图片例外：系统菜单", () => {
  it("桌面右键气泡 → preventDefault + 开菜单", () => {
    finePointer = true;
    const el = render(message());
    const bubble = el.querySelector(".bubble")!;
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
    act(() => {
      bubble.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(el.querySelector(".msg-menu")).not.toBeNull();
  });

  it("图片长按/右键一律不拦截（Android 原生保存图片）", () => {
    finePointer = true;
    const el = render(message({ images: [{ url: "https://x.test/a.png", alt: "图" }] }));
    const img = el.querySelector("img.msg-img")!;
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      img.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(el.querySelector(".msg-menu")).toBeNull();
  });
});

describe("尾随 click 防误触（长按弹菜单后）", () => {
  it("脚部长按开菜单后的尾随 click 被吞，不误触脚部按钮", () => {
    const el = render(message());
    const copyBtn = el.querySelector<HTMLButtonElement>(".msg-copy-btn")!;
    let copied = 0;
    copyBtn.addEventListener("click", () => {
      copied += 1;
    });
    longPressFoot(el);
    expect(el.querySelector(".msg-menu")).not.toBeNull();
    // 长按松手后内核补发的 click
    act(() => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(copied).toBe(0);
  });

  it("点空白关菜单：那一击被吞（不落到下方内容），后续点击正常", () => {
    const el = render(message());
    act(() => {
      el.querySelector<HTMLButtonElement>(".msg-more-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(el.querySelector(".msg-menu")).not.toBeNull();
    // 点空白（document 上 pointerdown 关菜单 + 武装吞一击）
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(pe("pointerdown", 50, 50));
    });
    expect(el.querySelector(".msg-menu")).toBeNull();
    let clicked = 0;
    outside.addEventListener("click", () => {
      clicked += 1;
    });
    act(() => {
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(clicked).toBe(0); // 关菜单那一击被吞
    act(() => {
      outside.dispatchEvent(pe("pointerdown"));
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(clicked).toBe(1); // 后续点击正常
    outside.remove();
  });
});
