import type { EffectivePolicyDto } from "./types";

/** 手机只描述协议已确认的设置，不把“有审批通道”说成“所有操作都会先问”。 */
export function codexPolicySummary(policy?: EffectivePolicyDto): string {
  const approval = policy?.approval === "never" ? "当前设置不请求操作审批"
    : policy?.approval === "untrusted" ? "需要确认的操作会在这里询问"
    : policy?.approval === "on-request" ? "模型提出申请时，才会在这里询问"
    : "审批设置尚未确认，请先核对电脑端设置";
  const files = policy?.sandbox === "read-only" ? "文件访问为只读"
    : policy?.sandbox === "workspace-write" ? "可修改工作区文件"
    : policy?.sandbox === "danger-full-access" ? "文件访问范围未限制"
    : "文件访问范围尚未确认";
  return `${approval}；${files}`;
}
export function codexAttachNotice(policy?: EffectivePolicyDto): string { return `已接管 Codex：${codexPolicySummary(policy)}`; }
/** 未知/缺失字段保持未知；不沿用上一进程的策略。 */
export function normalizeCodexPolicy(value: unknown): EffectivePolicyDto | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const approval = ["never", "untrusted", "on-request"].includes(String(p.approval)) ? String(p.approval) : "unknown";
  const sandbox = ["read-only", "workspace-write", "danger-full-access"].includes(String(p.sandbox)) ? String(p.sandbox) : "unknown";
  return { approval, sandbox, bypass: approval === "never" };
}
