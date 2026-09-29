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
  sendPrompt: (id: string, text: string, mode: PromptMode) => Promise<PromptResult>;
  onNotice?: (message: string) => void;
}

export const BUSY_NOTICE = "会话正忙，消息已自动排队（followUp），将在本轮结束后发送。";

export async function sendPromptWithFallback(
  id: string,
  text: string,
  deps: SendPromptDeps,
): Promise<SendPromptOutcome> {
  try {
    const result = await deps.sendPrompt(id, text, "prompt");
    return { result, busyFallback: false };
  } catch (err) {
    const isBusy = err instanceof ApiError && (err.status === 409 || err.code === "SESSION_BUSY");
    if (!isBusy) throw err;
    const result = await deps.sendPrompt(id, text, "followUp");
    deps.onNotice?.(BUSY_NOTICE);
    return { result, busyFallback: true };
  }
}
