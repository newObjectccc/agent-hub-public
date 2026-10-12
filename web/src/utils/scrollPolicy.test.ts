/**
 * 聊天滚动跟随策略测试：发送强制回底 vs 被动消息贴底跟随（防打扰）。
 */
import { describe, expect, it } from "vitest";
import { shouldFollowToBottom } from "./scrollPolicy";

const T = 160;

describe("shouldFollowToBottom", () => {
  it("发送后强制回底：无论离底部多远都跟随", () => {
    expect(
      shouldFollowToBottom({ force: true, distancePrev: 5000, distanceNow: 5000, threshold: T }),
    ).toBe(true);
  });

  it("被动新消息：贴底（任一口径 <160px）→ 跟随", () => {
    expect(shouldFollowToBottom({ force: false, distancePrev: 20, distanceNow: 20, threshold: T })).toBe(true);
    // 双口径：同帧上滚/内容收缩导致某一口径失真时，另一口径兜底
    expect(shouldFollowToBottom({ force: false, distancePrev: 10, distanceNow: 900, threshold: T })).toBe(true);
    expect(shouldFollowToBottom({ force: false, distancePrev: 900, distanceNow: 10, threshold: T })).toBe(true);
  });

  it("被动新消息：用户上翻看历史（两口径都远离底部）→ 不拽（防打扰）", () => {
    expect(shouldFollowToBottom({ force: false, distancePrev: 400, distanceNow: 400, threshold: T })).toBe(false);
  });

  it("边界：恰好等于阈值视为未贴底（与既有 160px 语义一致）", () => {
    expect(shouldFollowToBottom({ force: false, distancePrev: T, distanceNow: T, threshold: T })).toBe(false);
  });
});
