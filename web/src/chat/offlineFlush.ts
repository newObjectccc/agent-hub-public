/**
 * 离线队列 flush 装配（把真实 api/sendPromptWithMode/toast 接到纯队列逻辑）：
 * - online 事件 / WS 重连 / 徽章点击 / 单条重试统一从这里出口
 * - 空队列零开销直返；并发 flush 合并为同一趟（不重复发）
 */
import { api } from "../api/client";
import { sendPromptWithMode } from "../api/prompt";
import { showToast } from "../utils/toast";
import { flushQueue, getOfflineQueue, type FlushOptions, type FlushResult } from "./offlineQueue";

let running: Promise<FlushResult | null> | null = null;

/** 丢失 WS 回执时只读恢复；未知记录保留原文供人工核对。 */
export async function reconcileAttachReceipts(sessionId: string): Promise<void> {
  const store = getOfflineQueue();
  for (const item of store.pending(sessionId)) {
    if (item.source !== "codex" || !item.commandId) continue;
    try {
      const status = await api.getAttachCommandStatus(sessionId, item.commandId);
      if (status.state === "accepted" || status.state === "failed") {
        store.recordAttachAck(sessionId, item.commandId, status.state === "accepted", status.error);
      } else if (status.state === "unknown") {
        store.patch(item.localId, { commandId: undefined, autoRetry: false, lastError: "原指令回执已失效，请核对会话后手动重试" });
      }
    } catch { /* 网络仍未恢复时原样保留，不重发。 */ }
  }
}

export interface FlushNowOptions extends FlushOptions {
  /** 成功/失败出 toast（网络恢复自动补发等用户可感知场景） */
  notify?: boolean;
}

export function flushOfflineQueue(options: FlushNowOptions = {}): Promise<FlushResult | null> {
  if (running) return running;
  if (getOfflineQueue().list().length === 0) return Promise.resolve(null);
  const { notify = false, ...rest } = options;
  running = (async () => {
    try {
      const result = await flushQueue(
        getOfflineQueue(),
        {
          resolveSessionSource: async (id) => (await api.getSession(id, { limit: 1 })).session.source ?? null,
          uploadFile: (input, signal) => api.uploadFile(input, signal),
          sendPrompt: (id, text, mode, images, clientMessageId, signal) =>
            api.sendPrompt(id, text, mode, images, clientMessageId, signal),
          sendPromptWithMode,
          sendAttachMessage: (id, text, mode, clientMessageId, signal, images) =>
            api.sendAttachMessage(id, text, mode, clientMessageId, signal, images),
        },
        rest,
      );
      if (notify) {
        if (result.sent.length > 0) showToast(`📶 已补发 ${result.sent.length} 条消息`);
        if (result.failed.length > 0) showToast(`⚠️ ${result.failed.length} 条消息仍等待发送`);
      }
      return result;
    } catch {
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}
