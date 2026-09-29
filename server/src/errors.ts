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
  UNAUTHORIZED: "UNAUTHORIZED",
} as const;

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
  return {
    statusCode: 500,
    body: { error: { code: ErrorCodes.INTERNAL, message } },
  };
}
