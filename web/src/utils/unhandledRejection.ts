/**
 * 未处理 Promise 拒绝全局兜底（P2）：
 * 事件处理器里 `void doXxx()` 这类异步失败不裸吞——
 * - UI 层给 toast 反馈（ToastHost 已有同文案去重合并，不会刷屏），不崩 UI
 * - dev：console.warn 保留排查线索；生产：preventDefault 抑制浏览器默认报错，保持安静
 */
import { showToast } from "./toast";

/** 兜底提示文案（通用兜底，具体业务错误仍由各自内联提示负责） */
export const UNHANDLED_REJECTION_TOAST = "操作失败，请稍后重试";

export interface UnhandledRejectionGuardOptions {
  /** 提示出口（默认 toast 总线）；传 () => {} 可静音 */
  notify?: (text: string) => void;
  /** 是否开发模式（默认读 import.meta.env.DEV）；测试可显式注入 */
  dev?: boolean;
}

/** 派发/模拟 unhandledrejection 用的最小事件形状（jsdom 无 PromiseRejectionEvent 构造器） */
export interface UnhandledRejectionLike {
  reason: unknown;
  preventDefault: () => void;
}

function defaultDev(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * 安装全局兜底监听，返回卸载函数（幂等：重复安装各自卸载，互不影响）。
 */
export function installUnhandledRejectionGuard(
  options: UnhandledRejectionGuardOptions = {},
): () => void {
  const notify = options.notify ?? showToast;
  const dev = options.dev ?? defaultDev();

  const onUnhandled = (event: PromiseRejectionEvent): void => {
    const e = event as unknown as UnhandledRejectionLike;
    if (dev) {
      // dev 保留默认浏览器输出（不 preventDefault），warn 标明"已兜底"
      console.warn("[agent-hub] 未处理的 Promise 拒绝（已兜底，不影响 UI）", e.reason);
    } else {
      // 生产安静：抑制浏览器默认未捕获报错输出
      e.preventDefault?.();
    }
    try {
      notify(UNHANDLED_REJECTION_TOAST);
    } catch {
      // 提示通道自身失败也不影响 UI
    }
  };

  window.addEventListener("unhandledrejection", onUnhandled as EventListener);
  return () => window.removeEventListener("unhandledrejection", onUnhandled as EventListener);
}
