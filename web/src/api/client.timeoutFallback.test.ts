/**
 * AbortSignal.timeout 兼容降级（首屏可靠性 #3）：
 * 旧 WebView（iOS Safari < 15.4 等）无 AbortSignal.timeout，直接调用会 TypeError 崩掉请求层。
 * - feature detect 缺失时降级 AbortController + setTimeout 看门狗
 * - 降级超时同样映射 TIMEOUT 友好文案（旧 API 无 signal.reason，靠 didTimeout 兜底）
 * - 请求落定后清理定时器（不遗留挂起 setTimeout）
 * 测试手段：Object.defineProperty mock 删除 AbortSignal.timeout（afterEach 恢复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, request, DEFAULT_REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE } from "./client";

const fetchMock = vi.fn();

/** 原生 AbortSignal.timeout 属性描述符（测试后恢复，不污染其它用例） */
const nativeTimeoutDesc = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");

/** mock 删除 AbortSignal.timeout：模拟旧 WebView 环境 */
function removeNativeTimeout(): void {
  Object.defineProperty(AbortSignal, "timeout", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** 模拟真实 fetch 的挂起形态：signal abort 时以 reason（或 AbortError）拒绝 */
function hangingFetch(rejectWith: (signal: AbortSignal) => unknown): void {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(rejectWith(signal)));
    });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (nativeTimeoutDesc) Object.defineProperty(AbortSignal, "timeout", nativeTimeoutDesc);
  else delete (AbortSignal as { timeout?: unknown }).timeout;
});

describe("AbortSignal.timeout 缺失时降级 AbortController + setTimeout", () => {
  it("降级不崩：请求正常完成，透传的 signal 是未中止的 AbortSignal", async () => {
    removeNativeTimeout();
    vi.useFakeTimers();

    await expect(request("/api/ping")).resolves.toEqual({ ok: true });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
    // 请求落定后清理看门狗定时器（不遗留 30s 挂起 setTimeout）
    expect(vi.getTimerCount()).toBe(0);
  });

  it("降级超时：30s 看门狗 abort → ApiError code=TIMEOUT，文案「网络请求超时」", async () => {
    removeNativeTimeout();
    vi.useFakeTimers();
    hangingFetch((signal) => signal.reason ?? new DOMException("The user aborted a request.", "AbortError"));

    const pending = request("/api/ping").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("TIMEOUT");
    expect((err as ApiError).message).toBe(TIMEOUT_MESSAGE);
  });

  it("旧 WebView 形态：signal.reason 不存在、fetch 抛 AbortError，仍映射超时文案（didTimeout 兜底）", async () => {
    removeNativeTimeout();
    vi.useFakeTimers();
    hangingFetch((signal) => {
      // 模拟 AbortSignal.reason 缺失的旧 API：reason 不可读，只有 AbortError
      Object.defineProperty(signal, "reason", { value: undefined, configurable: true });
      return new DOMException("The user aborted a request.", "AbortError");
    });

    const pending = request("/api/ping").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("TIMEOUT");
    expect((err as ApiError).message).toBe(TIMEOUT_MESSAGE);
  });

  it("调用方自带 signal：降级环境也不引入看门狗（AbortController 语义不变）", async () => {
    removeNativeTimeout();
    vi.useFakeTimers();
    const controller = new AbortController();

    await request("/api/ping", { signal: controller.signal });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("api 层方法在降级环境同样可用（getSystem 成功返回）", async () => {
    removeNativeTimeout();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });

    await expect(api.getSystem()).resolves.toEqual({ status: "ok" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
