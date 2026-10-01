/**
 * 发送模式回合语义（UX 审查 AC4「发送模式静默重置」修复）：
 * - 粘性选择（⚡ 自动/💬 新消息）回合结束保留，不被静默改回 auto
 * - 一次性模式（✋ 插话/⏭ 排队）回合结束自动复位，且给一行轻提示（不静默）
 */
import { describe, expect, it } from "vitest";
import { isOneShotSendMode, resolveRoundEndMode } from "./sendMode";

describe("resolveRoundEndMode", () => {
  it("用户显式选择的粘性模式保留（auto/prompt 不被静默改回）", () => {
    expect(resolveRoundEndMode("auto")).toEqual({ mode: "auto", notice: null });
    expect(resolveRoundEndMode("prompt")).toEqual({ mode: "prompt", notice: null });
  });

  it("一次性模式（steer/followUp）回合结束复位为自动 + 轻提示", () => {
    const steer = resolveRoundEndMode("steer");
    expect(steer.mode).toBe("auto");
    expect(steer.notice).toContain("仅对本轮生效");
    const followUp = resolveRoundEndMode("followUp");
    expect(followUp.mode).toBe("auto");
    expect(followUp.notice).toContain("仅对本轮生效");
  });

  it("isOneShotSendMode 只认 steer/followUp", () => {
    expect(isOneShotSendMode("steer")).toBe(true);
    expect(isOneShotSendMode("followUp")).toBe(true);
    expect(isOneShotSendMode("auto")).toBe(false);
    expect(isOneShotSendMode("prompt")).toBe(false);
  });
});
