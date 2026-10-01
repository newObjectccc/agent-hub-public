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
  INVALID_MESSAGE: "INVALID_MESSAGE",
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
  // 上传 API（契约 §11）
  UPLOAD_TOO_LARGE: "UPLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  // 应用锁（契约 §13，F1）
  APP_LOCK_EXISTS: "APP_LOCK_EXISTS",
  APP_LOCK_NOT_CONFIGURED: "APP_LOCK_NOT_CONFIGURED",
  APP_LOCK_DENIED: "APP_LOCK_DENIED",
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

export function toErrorEnvelope(err: unknown): { statusCode: number; body: { error: { code: string; message: string } } } {
  if (err instanceof HubError) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Fastify 框架层错误（body 超限 FST_ERR_CTP_BODY_TOO_LARGE 等）携带 statusCode：
  // 保留 4xx 语义，避免把客户端错误误报成 500
  const fastifyLike = (typeof err === "object" && err !== null ? err : {}) as { statusCode?: unknown; code?: unknown };
  if (typeof fastifyLike.statusCode === "number" && fastifyLike.statusCode >= 400 && fastifyLike.statusCode < 600) {
    const code = typeof fastifyLike.code === "string" && fastifyLike.code !== "" ? fastifyLike.code : ErrorCodes.INVALID_REQUEST;
    return {
      statusCode: fastifyLike.statusCode,
      body: { error: { code, message } },
    };
  }
  return {
    statusCode: 500,
    body: { error: { code: ErrorCodes.INTERNAL, message } },
  };
}
