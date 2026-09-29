/**
 * 发送 prompt 的 409 自动降级逻辑（独立成纯函数便于测试）。
 *
 * 契约：POST /api/sessions/:id/prompt，mode="prompt" 时若会话正忙返回
 * 409 SESSION_BUSY；此时自动改用 mode="followUp"（排队到当前 run 结束后）
 * 并通过 onNotice 告知用户。
 */
import { ApiError } from "./client";
import type { PromptResult } from "./types";
import type { PromptMode } from "./client";

export interface SendPromptOutcome {
  result: PromptResult;
  /** 是否发生了 409 → followUp 自动降级 */
  busyFallback: boolean;
}

export interface SendPromptDeps {
  /** images 仅在有附件时作为第 4 参传入（保持旧 3 参 mock 兼容） */
  sendPrompt: (id: string, text: string, mode: PromptMode, images?: string[]) => Promise<PromptResult>;
  onNotice?: (message: string) => void;
}

/** 有附件才带第 4 参，保持旧调用/测试的参数匹配不变 */
function callSend(
  deps: SendPromptDeps,
  id: string,
  text: string,
  mode: PromptMode,
  images?: string[],
): Promise<PromptResult> {
  return images && images.length > 0 ? deps.sendPrompt(id, text, mode, images) : deps.sendPrompt(id, text, mode);
}

export const BUSY_NOTICE = "会话正忙，消息已自动排队（followUp），将在本轮结束后发送。";

/**
 * 发送模式：
 * - "auto"（默认）：保持 409 自动降级逻辑（prompt → 忙碌时 followUp）
 * - "prompt" / "steer" / "followUp"：手动模式，直接带对应 mode 提交，不再降级
 *   （steer=插入当前运行之后；followUp=排队到本轮结束）
 */
export type SendMode = "auto" | PromptMode;

export async function sendPromptWithFallback(
  id: string,
  text: string,
  deps: SendPromptDeps,
  images?: string[],
): Promise<SendPromptOutcome> {
  try {
    const result = await callSend(deps, id, text, "prompt", images);
    return { result, busyFallback: false };
  } catch (err) {
    const isBusy = err instanceof ApiError && (err.status === 409 || err.code === "SESSION_BUSY");
    if (!isBusy) throw err;
    const result = await callSend(deps, id, text, "followUp", images);
    deps.onNotice?.(BUSY_NOTICE);
    return { result, busyFallback: true };
  }
}

/**
 * 按 UI 选择的发送模式提交：auto 走 409 降级逻辑，手动模式直接带对应 mode。
 */
export async function sendPromptWithMode(
  id: string,
  text: string,
  mode: SendMode,
  deps: SendPromptDeps,
  images?: string[],
): Promise<SendPromptOutcome> {
  if (mode === "auto") return sendPromptWithFallback(id, text, deps, images);
  const result = await callSend(deps, id, text, mode, images);
  return { result, busyFallback: false };
}
