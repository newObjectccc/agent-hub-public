/**
 * 未处理 Promise 拒绝全局兜底（P2）：
 * - dev：console.warn 提示（保留默认浏览器输出），不崩 UI
 * - 生产：preventDefault 抑制默认报错输出，保持安静
 * - 两环境均走 toast 反馈（不裸吞事件处理器的异步失败）；卸载后不再响应
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissToast, getToasts } from "./toast";
import {
  installUnhandledRejectionGuard,
  UNHANDLED_REJECTION_TOAST,
  type UnhandledRejectionLike,
} from "./unhandledRejection";

/** jsdom 无 PromiseRejectionEvent 构造器：用 Event + reason/preventDefault 模拟 */
function fireUnhandled(reason: unknown): UnhandledRejectionLike {
  const preventDefault = vi.fn();
  const event = Object.assign(new Event("unhandledrejection"), { reason, preventDefault });
  window.dispatchEvent(event);
  return event as unknown as UnhandledRejectionLike;
}

afterEach(() => {
  for (const t of getToasts()) dismissToast(t.id);
  vi.restoreAllMocks();
});

describe("installUnhandledRejectionGuard", () => {
  it("dev：console.warn 记录原因 + toast 反馈，不 preventDefault（保留默认错误输出）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notify = vi.fn();
    const uninstall = installUnhandledRejectionGuard({ dev: true, notify });

    const ev = fireUnhandled(new Error("handler 炸了"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(UNHANDLED_REJECTION_TOAST);
    uninstall();
  });

  it("生产：preventDefault 抑制默认报错（安静）、不打 console，toast 反馈照给", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notify = vi.fn();
    const uninstall = installUnhandledRejectionGuard({ dev: false, notify });

    const ev = fireUnhandled("字符串原因");

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(UNHANDLED_REJECTION_TOAST);
    uninstall();
  });

  it("默认 notify 走 toast 总线（ToastHost 接入零成本）：产生同文案 toast", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const uninstall = installUnhandledRejectionGuard({ dev: false });

    fireUnhandled(new Error("boom"));

    const texts = getToasts().map((t) => t.text);
    expect(texts).toContain(UNHANDLED_REJECTION_TOAST);
    uninstall();
  });

  it("卸载后不再兜底；notify 自身抛错不影响 UI（不二次冒泡）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notify = vi.fn(() => {
      throw new Error("toast 也炸了");
    });
    const uninstall = installUnhandledRejectionGuard({ dev: false, notify });

    // notify 抛错被内部吞掉，事件处理不抛
    expect(() => fireUnhandled(new Error("boom"))).not.toThrow();
    uninstall();

    fireUnhandled(new Error("boom"));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
