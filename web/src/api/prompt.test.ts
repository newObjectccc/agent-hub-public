import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { BUSY_NOTICE, sendPromptWithFallback } from "./prompt";
import type { PromptResult } from "./types";

const ok: PromptResult = { accepted: true, mode: "prompt" };

describe("sendPromptWithFallback（409 SESSION_BUSY → followUp）", () => {
  it("空闲时以 mode=prompt 一次发送成功，不降级", async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ ...ok });
    const onNotice = vi.fn();
    const out = await sendPromptWithFallback("s1", "你好", { sendPrompt, onNotice });
    expect(out.busyFallback).toBe(false);
    expect(out.result.mode).toBe("prompt");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith("s1", "你好", "prompt");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("收到 409 SESSION_BUSY 时自动改用 followUp 并提示用户", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "SESSION_BUSY", "session busy"))
      .mockResolvedValueOnce({ accepted: true, mode: "followUp" });
    const onNotice = vi.fn();
    const out = await sendPromptWithFallback("s1", "继续", { sendPrompt, onNotice });
    expect(out.busyFallback).toBe(true);
    expect(out.result.mode).toBe("followUp");
    expect(sendPrompt).toHaveBeenNthCalledWith(1, "s1", "继续", "prompt");
    expect(sendPrompt).toHaveBeenNthCalledWith(2, "s1", "继续", "followUp");
    expect(onNotice).toHaveBeenCalledWith(BUSY_NOTICE);
  });

  it("status 非 409 但 code=SESSION_BUSY 也按忙碌降级", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, "SESSION_BUSY", "busy"))
      .mockResolvedValueOnce({ accepted: true, mode: "followUp" });
    const out = await sendPromptWithFallback("s1", "x", { sendPrompt });
    expect(out.busyFallback).toBe(true);
    expect(out.result.mode).toBe("followUp");
  });

  it("其他错误不降级、直接抛出", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));
    await expect(sendPromptWithFallback("s1", "x", { sendPrompt })).rejects.toThrow("boom");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("降级后 followUp 仍失败则抛出", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "SESSION_BUSY", "busy"))
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "second fail"));
    await expect(sendPromptWithFallback("s1", "x", { sendPrompt })).rejects.toThrow("second fail");
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });
});
