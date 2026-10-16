/** 协议形状的纯函数：审批结果绝不采用手机回传的权限配置。 */
import { resolve } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import { isRecord } from "./codex-rpc.js";

export type CodexDriverMode = "prompt" | "steer" | "followUp";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalType = "commandExecution" | "fileChange" | "permissions";
export interface CodexApprovalItemPreview { command?: string; fileChangeDetail?: string }
export type CodexUserInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };
export const APPROVAL_PREVIEW_MAX_BYTES = 8 * 1024;
const PREVIEW_TRUNCATED = "\n…（预览已截断，完整改动请在电脑端查看）";
const NO_FILE_DIFF = "尚未收到该项的文件 diff；请先在电脑端核对实际改动。";

export const APPROVAL_METHODS: Readonly<Record<string, CodexApprovalType>> = Object.freeze({
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
});

/** 进程参数不覆盖审批策略或沙箱设置。 */
export function buildDriverArgs(): string[] { return ["app-server"]; }

export function buildResumeParams(threadId: string, options: { cwd?: string; approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandbox } = {}): Record<string, unknown> {
  return {
    threadId,
    excludeTurns: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  };
}

export function parseDriverMode(value: unknown): CodexDriverMode {
  if (value === undefined || value === null) return "prompt";
  if (value === "prompt" || value === "steer" || value === "followUp") return value;
  throw new HubError(ErrorCodes.INVALID_REQUEST, "mode 必须为 prompt|steer|followUp");
}

/** 路径已由上传路由校验，图片通过原生 localImage 输入传入。 */
export function buildTurnInput(text: unknown, images: unknown, cwd: string): CodexUserInput[] {
  if (typeof text !== "string") throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是字符串");
  if (images !== undefined && (!Array.isArray(images) || images.length > 20)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "images 必须是图片路径数组（最多 20 张）");
  }
  const result: CodexUserInput[] = text.trim() === "" ? [] : [{ type: "text", text, text_elements: [] }];
  for (const image of (images ?? []) as unknown[]) {
    const path = typeof image === "string" ? image : isRecord(image) ? image.path : undefined;
    if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "图片缺少有效的本地路径");
    }
    result.push({ type: "localImage", path: resolve(cwd || process.cwd(), path) });
  }
  if (result.length === 0) throw new HubError(ErrorCodes.INVALID_REQUEST, "text 或 images 至少提供一项");
  return result;
}

/** 保存原请求权限的独立快照，不使用手机回传的权限或授权范围。 */
export function snapshotRequestedPermissions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const field of ["fileSystem", "network"]) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) result[field] = JSON.parse(JSON.stringify(value[field]));
  }
  return result;
}

export function buildApprovalResult(
  type: CodexApprovalType,
  outcome: "allow" | "deny",
  originalPermissions: Record<string, unknown> = {},
  cancelled = false,
): Record<string, unknown> {
  if (type === "permissions") return {
    permissions: outcome === "allow" ? snapshotRequestedPermissions(originalPermissions) : {},
    scope: "turn",
  };
  return { decision: outcome === "allow" ? "accept" : cancelled ? "cancel" : "decline" };
}

/** 权限卡仅展示白名单中的可读摘要，不透传整个服务端请求。 */
export function hostRequestPreview(type: CodexApprovalType, params: Record<string, unknown>, item?: CodexApprovalItemPreview): { title: string; detail: string | null; toolName: string } {
  const reason = typeof params.reason === "string" ? safePreview(params.reason, 1_000) : "";
  if (type === "commandExecution") {
    const command = typeof params.command === "string" && params.command.trim() ? safePreview(params.command, 1_000) : item?.command ?? "";
    const cwd = typeof params.cwd === "string" ? safePreview(params.cwd, 300) : "";
    return {
      title: command ? `执行命令：${command.slice(0, 120)}` : "允许执行命令？",
      detail: [command, cwd ? `目录：${cwd}` : "", reason].filter(Boolean).join("\n") || null,
      toolName: "commandExecution",
    };
  }
  if (type === "fileChange") return {
    title: "允许修改文件？",
    detail: boundedApprovalDetail([reason, item?.fileChangeDetail ?? NO_FILE_DIFF].filter(Boolean).join("\n\n")),
    toolName: "fileChange",
  };
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const summary: string[] = [];
  if (isRecord(permissions.network) && permissions.network.enabled === true) summary.push("请求网络访问");
  if (isRecord(permissions.fileSystem)) {
    const fs = permissions.fileSystem;
    for (const field of ["read", "write"]) {
      if (Array.isArray(fs[field])) {
        const paths = (fs[field] as unknown[]).filter((path): path is string => typeof path === "string");
        if (paths.length) summary.push(`${field === "write" ? "写入" : "读取"}：${safePreview(paths.join(", "), 600)}`);
      }
    }
    if (Array.isArray(fs.entries)) {
      for (const entry of fs.entries.slice(0, 20)) {
        if (!isRecord(entry) || !isRecord(entry.path)) continue;
        const path = entry.path;
        const name = typeof path.path === "string" ? path.path : typeof path.pattern === "string" ? path.pattern : "系统路径";
        const access = entry.access === "write" ? "写入" : entry.access === "deny" ? "限制" : "读取";
        summary.push(`${access}：${safePreview(name, 200)}`);
      }
    }
  }
  return { title: "允许本轮新增权限？", detail: [reason, ...summary].filter(Boolean).join("\n") || "仅授予原请求中的权限，范围限当前轮", toolName: "permissions" };
}

/** 仅缓存已收到的同轮 item 白名单字段；绝不保存/序列化整个工具条目。 */
export function approvalItemPreview(item: Record<string, unknown>): CodexApprovalItemPreview | null {
  if (item.type === "commandExecution" && typeof item.command === "string") return { command: safePreview(item.command.slice(0, 1_001), 1_000) };
  if (item.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) return null;
  const parts: string[] = [];
  let clipped = false;
  for (const [index, value] of item.changes.entries()) {
    if (index >= 100) { clipped = true; break; }
    if (!isRecord(value)) continue;
    const path = typeof value.path === "string" ? safePreview(value.path.slice(0, 513), 512) : "未知文件";
    const kind = isRecord(value.kind) ? value.kind : {};
    const action = kind.type === "add" ? "新增" : kind.type === "delete" ? "删除" : "修改";
    const move = typeof kind.move_path === "string" ? `\n移动至：${safePreview(kind.move_path.slice(0, 513), 512)}` : "";
    const diff = typeof value.diff === "string" && value.diff ? safePreview(value.diff.slice(0, APPROVAL_PREVIEW_MAX_BYTES + 1), APPROVAL_PREVIEW_MAX_BYTES + 1) : "尚无该文件的 diff";
    parts.push(`文件：${path}（${action}）${move}\n${diff}`);
    clipped ||= (typeof value.diff === "string" && value.diff.length > APPROVAL_PREVIEW_MAX_BYTES) ||
      (typeof value.path === "string" && value.path.length > 512) || (typeof kind.move_path === "string" && kind.move_path.length > 512);
    if (Buffer.byteLength(parts.join("\n\n")) > APPROVAL_PREVIEW_MAX_BYTES) { clipped = true; break; }
  }
  if (parts.length === 0) return { fileChangeDetail: NO_FILE_DIFF };
  return { fileChangeDetail: boundedApprovalDetail(parts.join("\n\n"), clipped) };
}

function boundedApprovalDetail(value: string, clipped = false): string {
  if (!clipped && Buffer.byteLength(value) <= APPROVAL_PREVIEW_MAX_BYTES) return value;
  const budget = APPROVAL_PREVIEW_MAX_BYTES - Buffer.byteLength(PREVIEW_TRUNCATED);
  const prefix = Buffer.from(value).subarray(0, budget).toString("utf8").replace(/\uFFFD$/, "");
  return `${prefix}${PREVIEW_TRUNCATED}`;
}

/** 错误、命令参数和权限摘要中的常见凭据格式先脱敏再展示。 */
export function safePreview(value: string, limit = 1_000): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/((?:[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .slice(0, limit);
}

export function codexMessageId(threadId: string, itemId: string): string { return `codex-${threadId}-${itemId}`; }
