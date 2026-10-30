/**
 * 统一错误封装：{ "error": { "code": string, "message": string } }
 */

export const ErrorCodes = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_BUSY: "SESSION_BUSY",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_CWD: "INVALID_CWD",
  INTERNAL: "INTERNAL",
  PROMPT_FAILED: "PROMPT_FAILED",
  /** 上下文溢出（可自救：前端据此给「压缩上下文」一键动作，而非只报失败） */
  CONTEXT_OVERFLOW: "CONTEXT_OVERFLOW",
  /** 会话文件损坏/丢失/工作目录失效——无法继续这个会话（带可行动中文原因） */
  SESSION_CORRUPT: "SESSION_CORRUPT",
  /**
   * 同 clientMessageId 的上一次提交还在处理中（尚未得出受理结果）。
   * 此前这种情况会伪报 `accepted:true`：若首发最终 409/500，重发方已经以为成功了，
   * 消息就静默消失。现在明确回 409，前端保留在离线队列里重试（同键仍幂等，不双执行）。
   */
  PROMPT_IN_FLIGHT: "PROMPT_IN_FLIGHT",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  // git/文件只读 API（契约 §6）
  NOT_REPO: "NOT_REPO",
  INVALID_PATH: "INVALID_PATH",
  INVALID_FILE: "INVALID_FILE",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  GIT_FAILED: "GIT_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  // 终端接管 / 指令队列（E3 双模式）
  ATTACH_UNAVAILABLE: "ATTACH_UNAVAILABLE",
  ATTACH_REQUIRED: "ATTACH_REQUIRED",
  ATTACH_ACTIVE: "ATTACH_ACTIVE",
  ATTACH_QUEUE_FULL: "ATTACH_QUEUE_FULL",
  /**
   * 外部（电脑终端）正持有/正在写该会话：平行发送会与终端双写同一 JSONL。
   * pi 的会话文件是 append-only + leafId 树，两个进程各自维护 leafId 会产生同 parent 分叉
   * （一侧消息在 selectActiveBranch 回溯下静默不可见）；版本迁移触发 SessionManager._rewriteFile()
   * 时更会用自己内存的 entries 截断重写、永久抹掉对方已追加的行。
   */
  EXTERNAL_ACTIVE: "EXTERNAL_ACTIVE",
  // hub 驱动接管（claude，docs/CLAUDE_DRIVER.md）
  /** 驱动进程并发上限 */
  DRIVER_LIMIT: "DRIVER_LIMIT",
  /** 驱动进程异常退出 */
  DRIVER_FAILED: "DRIVER_FAILED",
  /** 权限请求不存在 */
  HOST_REQUEST_NOT_FOUND: "HOST_REQUEST_NOT_FOUND",
  /** 权限请求已决（幂等回放终态） */
  HOST_REQUEST_RESOLVED: "HOST_REQUEST_RESOLVED",
  // 上传 API（契约 §15）
  UPLOAD_TOO_LARGE: "UPLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  // 应用锁（契约 §13，F1）
  APP_LOCK_EXISTS: "APP_LOCK_EXISTS",
  APP_LOCK_NOT_CONFIGURED: "APP_LOCK_NOT_CONFIGURED",
  APP_LOCK_DENIED: "APP_LOCK_DENIED",
  /** 锁屏状态全局门禁：未提供解锁令牌（423 Locked） */
  APP_LOCKED: "APP_LOCKED",
  // ttyd Web 终端（契约 §13）
  TERMINAL_UNAVAILABLE: "TERMINAL_UNAVAILABLE",} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class HubError extends Error {
  readonly code: ErrorCode | string;
  readonly statusCode: number;

  constructor(code: ErrorCode | string, message: string, statusCode = 400) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 500 信封固定文案：非 HubError 的内部错误绝不回真实 message（只进服务端日志） */
export const INTERNAL_ERROR_MESSAGE = "internal error";

export function toErrorEnvelope(err: unknown): { statusCode: number; body: { error: { code: string; message: string } } } {
  if (err instanceof HubError) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Fastify 框架层错误（body 超限 FST_ERR_CTP_BODY_TOO_LARGE 等）携带 statusCode：
  // 保留 4xx 语义，避免把客户端错误误报成 500（5xx 一律隐藏内部 message）
  const fastifyLike = (typeof err === "object" && err !== null ? err : {}) as { statusCode?: unknown; code?: unknown };
  if (
    typeof fastifyLike.statusCode === "number" &&
    fastifyLike.statusCode >= 400 &&
    fastifyLike.statusCode < 500
  ) {
    const code = typeof fastifyLike.code === "string" && fastifyLike.code !== "" ? fastifyLike.code : ErrorCodes.INVALID_REQUEST;
    return {
      statusCode: fastifyLike.statusCode,
      body: { error: { code, message } },
    };
  }
  return {
    statusCode: 500,
    body: { error: { code: ErrorCodes.INTERNAL, message: INTERNAL_ERROR_MESSAGE } },
  };
}
