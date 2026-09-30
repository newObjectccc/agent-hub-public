import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { BUSY_NOTICE, sendPromptWithFallback, sendPromptWithMode } from "./prompt";
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

  it("attach 冲突 409 ATTACH_ACTIVE 不按忙碌降级（不重试不二次报错）", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError(409, "ATTACH_ACTIVE", "终端接管中"));
    await expect(sendPromptWithFallback("s1", "x", { sendPrompt })).rejects.toThrow("终端接管中");
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

describe("sendPromptWithMode（手动模式直接带对应 mode 提交）", () => {
  it("auto：保持 409 降级逻辑（prompt → followUp）", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "SESSION_BUSY", "busy"))
      .mockResolvedValueOnce({ accepted: true, mode: "followUp" });
    const onNotice = vi.fn();
    const out = await sendPromptWithMode("s1", "继续", "auto", { sendPrompt, onNotice });
    expect(out.busyFallback).toBe(true);
    expect(sendPrompt).toHaveBeenNthCalledWith(1, "s1", "继续", "prompt");
    expect(sendPrompt).toHaveBeenNthCalledWith(2, "s1", "继续", "followUp");
    expect(onNotice).toHaveBeenCalledWith(BUSY_NOTICE);
  });

  it("steer：直接带 mode=steer，不降级（409 也不重试）", async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ accepted: true, mode: "steer" });
    const onNotice = vi.fn();
    const out = await sendPromptWithMode("s1", "插一句", "steer", { sendPrompt, onNotice });
    expect(out.busyFallback).toBe(false);
    expect(out.result.mode).toBe("steer");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith("s1", "插一句", "steer");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("followUp：直接带 mode=followUp 排队发送", async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ accepted: true, mode: "followUp" });
    const out = await sendPromptWithMode("s1", "跑完看下日志", "followUp", { sendPrompt });
    expect(out.busyFallback).toBe(false);
    expect(sendPrompt).toHaveBeenCalledWith("s1", "跑完看下日志", "followUp");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("prompt：手动新消息直传，不触发降级", async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ accepted: true, mode: "prompt" });
    const out = await sendPromptWithMode("s1", "新消息", "prompt", { sendPrompt });
    expect(out.busyFallback).toBe(false);
    expect(sendPrompt).toHaveBeenCalledWith("s1", "新消息", "prompt");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("手动模式出错直接抛出（不自动改 followUp）", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError(409, "SESSION_BUSY", "busy"));
    await expect(sendPromptWithMode("s1", "x", "steer", { sendPrompt })).rejects.toThrow("busy");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});
