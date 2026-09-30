/**
 * 阶段化等待反馈：WS 事件 → 阶段推进 + 已等待计时文案。
 */
import { describe, expect, it } from "vitest";
import { formatElapsed, waitPhaseAfterEvent, WAIT_PHASE_META, type WaitPhase } from "./waitPhase";

describe("waitPhaseAfterEvent（阶段感知）", () => {
  const cases: Array<[WaitPhase, string, WaitPhase]> = [
    ["sending", "message_start", "thinking"],
    ["thinking", "thinking_delta", "thinking"],
    ["thinking", "tool_start", "tool"],
    ["tool", "tool_end", "thinking"],
    ["thinking", "text_delta", "replying"],
    ["replying", "tool_start", "tool"],
    // message_end 不回退阶段（pi 工具执行常在 message_end 之后）
    ["replying", "message_end", "replying"],
    ["tool", "message_end", "tool"],
    ["replying", "status", "replying"],
    ["tool", "agent_settled", "tool"],
  ];
  for (const [prev, event, next] of cases) {
    it(`${prev} + ${event} → ${next}`, () => {
      expect(waitPhaseAfterEvent(prev, event)).toBe(next);
    });
  }

  it("四阶段各有图标与文案（状态条展示）", () => {
    expect(WAIT_PHASE_META.sending).toEqual({ icon: "📤", label: "发送中" });
    expect(WAIT_PHASE_META.thinking.icon).toBe("🧠");
    expect(WAIT_PHASE_META.tool.icon).toBe("🔧");
    expect(WAIT_PHASE_META.replying.icon).toBe("✍️");
  });
});

describe("formatElapsed（已等待计时文案）", () => {
  it("秒级 <60s → `45s`；分钟 → `2m 05s`；负数/NaN 防御按 0", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(45_678)).toBe("45s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(-500)).toBe("0s");
  });
});
