/**
 * 语音按钮手势（UX 审查 AC4）：
 * - pointer capture：手指移出按钮不再截断录音写回半句（旧 onPointerLeave bug）
 * - 移出显示「松开取消」提示；在按钮外松开 = 取消（IM 惯例，不写回）
 * - 在按钮内松开才把最终文本写回输入框
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInputButton } from "./VoiceInputButton";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 假 SpeechRecognition：stop() 同步回调 onend（真实实现的常见时序） */
class FakeRec {
  static instances: FakeRec[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor() {
    FakeRec.instances.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
    this.onend?.();
  }
  abort(): void {
    this.onend?.();
  }
}

let root: Root | null = null;
let container: HTMLElement | null = null;

const BUTTON_RECT = { left: 100, top: 200, right: 144, bottom: 244, width: 44, height: 44, x: 100, y: 200, toJSON: () => ({}) };

function render(onTranscript: (text: string) => void): HTMLButtonElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VoiceInputButton onTranscript={onTranscript} />);
  });
  const btn = container.querySelector<HTMLButtonElement>(".voice-btn")!;
  btn.getBoundingClientRect = () => BUTTON_RECT;
  return btn;
}

function fire(el: Element, type: string, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

function emitResult(btn: HTMLButtonElement, transcript: string): void {
  const rec = FakeRec.instances[FakeRec.instances.length - 1];
  act(() => {
    rec.onresult?.({ results: [{ isFinal: true, 0: { transcript } }] });
  });
  void btn;
}

beforeEach(() => {
  FakeRec.instances = [];
  vi.stubGlobal("SpeechRecognition", FakeRec);
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("VoiceInputButton 手势", () => {
  it("按住说话、按钮内松开 → 最终文本写回输入框", () => {
    const onTranscript = vi.fn();
    const btn = render(onTranscript);
    fire(btn, "pointerdown", 120, 220);
    expect(FakeRec.instances).toHaveLength(1);
    expect(FakeRec.instances[0].started).toBe(true);
    emitResult(btn, " 你好世界 ");
    fire(btn, "pointerup", 120, 220);
    expect(onTranscript).toHaveBeenCalledWith("你好世界");
  });

  it("手指移出按钮：显示「松开取消」提示；按钮外松开=取消，不写回半句", () => {
    const onTranscript = vi.fn();
    const btn = render(onTranscript);
    fire(btn, "pointerdown", 120, 220);
    emitResult(btn, "说了一半的句");
    // 移出按钮 → 提示
    fire(btn, "pointermove", 300, 300);
    expect(container!.textContent).toContain("松开取消");
    // 按钮外松开 → 取消：已识别内容丢弃，不写回
    fire(btn, "pointerup", 300, 300);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(FakeRec.instances[0].stopped).toBe(true);
    expect(container!.querySelector(".voice-btn.recording")).toBeNull();
  });

  it("移出后移回按钮内松开 → 正常写回（提示消失）", () => {
    const onTranscript = vi.fn();
    const btn = render(onTranscript);
    fire(btn, "pointerdown", 120, 220);
    emitResult(btn, "完整的话");
    fire(btn, "pointermove", 300, 300);
    fire(btn, "pointermove", 120, 220);
    expect(container!.textContent).not.toContain("松开取消");
    fire(btn, "pointerup", 120, 220);
    expect(onTranscript).toHaveBeenCalledWith("完整的话");
  });

  it("手指移出不再截断录音（旧 onPointerLeave bug 回归）：识别仍在进行", () => {
    const onTranscript = vi.fn();
    const btn = render(onTranscript);
    fire(btn, "pointerdown", 120, 220);
    const rec = FakeRec.instances[0];
    fire(btn, "pointerleave", 300, 300);
    // 录音未被停止、没有半句被写回
    expect(rec.stopped).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(container!.querySelector(".voice-btn.recording")).not.toBeNull();
    // 照常在按钮内松开收尾
    emitResult(btn, "后续完整的话");
    fire(btn, "pointerup", 120, 220);
    expect(onTranscript).toHaveBeenCalledWith("后续完整的话");
  });

  it("pointercancel（系统手势打断）= 取消，不写回", () => {
    const onTranscript = vi.fn();
    const btn = render(onTranscript);
    fire(btn, "pointerdown", 120, 220);
    emitResult(btn, "被打断的话");
    fire(btn, "pointercancel", 120, 220);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
