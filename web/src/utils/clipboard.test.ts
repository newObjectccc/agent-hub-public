/**
 * 剪贴板三层链路（utils/clipboard.ts）：
 * 1. Clipboard API 可用 → writeText（失败落降级）
 * 2. HTTP tailnet 无 Clipboard API → execCommand 降级（iOS select() 选不中 → setSelectionRange 加固）
 * 3. 全失败 → false（调用方 toast 引导手动选择）
 *
 * 回归背景：iPhone 上「复制空文本」根因是 readonly textarea + select() 选不中，
 * 必须 setSelectionRange 显式选区；execCommand 返回值不可信 → 成功判定保守（选区真覆盖全文才算）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubClipboard(ok: boolean): void {
  Object.defineProperty(navigator, "clipboard", {
    value: ok ? { writeText } : undefined,
    configurable: true,
  });
}

function spyFallback(): { selectionRange: ReturnType<typeof vi.fn>; execResult: boolean | null } {
  // 捕获 fallbackCopy 里 textarea 的 setSelectionRange 调用与 execCommand 结果
  const selectionRange = vi.fn();
  const orig = HTMLTextAreaElement.prototype.setSelectionRange;
  vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange").mockImplementation(function (
    this: HTMLTextAreaElement,
    start: number | null,
    end: number | null,
    direction?: "forward" | "backward" | "none",
  ) {
    selectionRange(start, end);
    orig.call(this, start ?? 0, end ?? 0, direction);
  });
  const state = { selectionRange, execResult: null as boolean | null };
  return state;
}

describe("copyText：Clipboard API 路径", () => {
  it("writeText 可用 → 复制成功", async () => {
    stubClipboard(true);
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("writeText reject（iOS standalone quirk）→ 落 execCommand 降级", async () => {
    writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    stubClipboard(true);
    const exec = vi.fn(() => true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    expect(await copyText("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("空文本直接失败（不写剪贴板）", async () => {
    stubClipboard(true);
    expect(await copyText("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("copyText：execCommand 降级（HTTP tailnet / 老 WebView）", () => {
  it("setSelectionRange 显式选中全文（iOS select() 选不中的根因修复）", async () => {
    stubClipboard(false);
    const { selectionRange } = spyFallback();
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
    const ok = await copyText("复制这段文字");
    expect(ok).toBe(true);
    expect(selectionRange).toHaveBeenCalledWith(0, "复制这段文字".length);
  });

  it("execCommand 返回 false → 失败（保守判定，不误报已复制）", async () => {
    stubClipboard(false);
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    expect(await copyText("hello")).toBe(false);
  });

  it("execCommand 不存在（jsdom 默认）→ 失败", async () => {
    stubClipboard(false);
    expect(await copyText("hello")).toBe(false);
  });

  it("降级后清理临时 textarea（不残留 DOM）", async () => {
    stubClipboard(false);
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
    const before = document.querySelectorAll("textarea").length;
    await copyText("hello");
    expect(document.querySelectorAll("textarea").length).toBe(before);
  });
});
