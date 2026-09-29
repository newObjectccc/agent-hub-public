/**
 * prompt mode 决策（纯函数，独立可测）。
 *
 * 契约语义（docs/API_CONTRACT.md §1）：
 * - "prompt"（默认）：空闲时发送；会话正忙且未指定 mode（或显式 "prompt"）时 409 SESSION_BUSY
 * - "steer"：插入当前运行之后（转向）
 * - "followUp"：排队到当前 run 结束后
 *
 * 保守假设：空闲时 steer/followUp 一律退化为直接发送（prompt）。
 */
export type PromptMode = "prompt" | "steer" | "followUp";

export const PROMPT_MODES: readonly string[] = ["prompt", "steer", "followUp"];

export type PromptDecision =
  | { kind: "prompt" }
  | { kind: "steer" }
  | { kind: "followUp" }
  | { kind: "busy" };

/** 解析请求里的 mode；未指定返回 undefined，非法值返回 null */
export function parsePromptMode(value: unknown): PromptMode | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && PROMPT_MODES.includes(value)) return value as PromptMode;
  return null;
}

export function decidePromptAction(isBusy: boolean, mode: PromptMode | undefined): PromptDecision {
  if (!isBusy) return { kind: "prompt" };
  if (mode === "steer") return { kind: "steer" };
  if (mode === "followUp") return { kind: "followUp" };
  // 正忙且未指定 mode / 显式 prompt → 需要 409
  return { kind: "busy" };
}
