/**
 * request() 默认超时（P2）：弱网挂起 Promise 永不落定 → UI 永久 loading。
 * - 未传 signal 默认 AbortSignal.timeout(30_000)（AbortController mock 验证）
 * - 超时（TimeoutError，含 fetch 阶段与读 body 阶段）→ 友好文案「网络请求超时」
 * - 调用方自带 signal 完全兼容：不叠加超时、主动 abort（AbortError）不伪装成超时
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, request, DEFAULT_REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request 默认超时（P2）", () => {
  it("未传 signal：默认 AbortSignal.timeout(30_000) 并透传给 fetch", async () => {
    const fakeSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);

    await request("/api/ping");

    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(fakeSignal);
  });

  it("fetch 挂起超时（TimeoutError）→ ApiError code=TIMEOUT，文案「网络请求超时」", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    const err = await request("/api/ping").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe("TIMEOUT");
    expect(apiErr.message).toBe(TIMEOUT_MESSAGE);
    expect(apiErr.message).toContain("网络请求超时");
  });

  it("AbortController 超时中止（signal.reason=TimeoutError）同样映射为超时文案", async () => {
    // 模拟 AbortSignal.timeout 的中止语义：fetch 拒绝为 AbortError，但 signal.reason 是 TimeoutError
    const controller = new AbortController();
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    fetchMock.mockRejectedValue(new DOMException("The user aborted a request.", "AbortError"));

    const err = await request("/api/ping", { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(TIMEOUT_MESSAGE);
  });

  it("读响应体阶段超时（res.json 抛 TimeoutError）→ 同样映射超时文案", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    });

    const err = await request("/api/ping").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(TIMEOUT_MESSAGE);
  });

  it("调用方自带 signal：不叠加默认超时（AbortSignal.timeout 不调用），signal 原样透传", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await request("/api/ping", { signal: controller.signal });

    expect(timeoutSpy).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("调用方主动 abort（AbortError）原样抛出，不伪装成超时（既有取消语义不变）", async () => {
    const controller = new AbortController();
    const abortErr = new DOMException("The user aborted a request.", "AbortError");
    fetchMock.mockRejectedValue(abortErr);

    const err = await request("/api/ping", { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBe(abortErr);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("非超时网络错误原样抛出；HTTP 错误信封仍归一为 ApiError", async () => {
    const netErr = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(netErr);
    await expect(request("/api/ping")).rejects.toBe(netErr);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "INTERNAL", message: "炸了" } }),
    });
    await expect(request("/api/ping")).rejects.toMatchObject({ status: 500, code: "INTERNAL", message: "炸了" });
  });

  it("api 层方法（getSystem 等）同样走默认超时兜底", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    await api.getSystem();
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });
});
