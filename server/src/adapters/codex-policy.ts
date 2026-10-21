/** 仅依赖协议回显比较权限；不读取用户配置、凭据或运行模型。 */
import { isAbsolute, resolve } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import { isRecord } from "./codex-rpc.js";
import { parseEffectivePolicy, type CodexApprovalPolicy, type CodexSandbox } from "./codex-host-protocol.js";
export interface PolicyOverrides { approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandbox }
const APPROVAL = ["never", "on-request", "untrusted"];
const SANDBOX = ["danger-full-access", "workspace-write", "read-only"];
function fail(message: string): never { throw new HubError(ErrorCodes.INVALID_REQUEST, `${message}；本次接管已停止，未执行任务。可改为 inherit 沿用电脑端设置`, 400); }

/** 初次恢复只继承设置；先拒绝已知放宽，再决定是否需要以新进程应用更严覆盖。 */
export function planPolicyOverrides(baseline: unknown, requested: PolicyOverrides): PolicyOverrides {
  const policy = parseEffectivePolicy(baseline);
  const result: PolicyOverrides = {};
  for (const [key, field, ranks] of [["approvalPolicy", "approval", APPROVAL], ["sandbox", "sandbox", SANDBOX]] as const) {
    const target = requested[key];
    if (target === undefined) continue;
    const original = policy?.[field] ?? "unknown";
    if (original === target) continue;
    const before = ranks.indexOf(original), after = ranks.indexOf(target);
    if (before < 0 || after < 0) fail("无法确认 Codex 原有权限，不允许覆盖未知策略");
    if (after < before) fail("配置的 Codex 权限比电脑端更宽松，不允许放宽");
    if (key === "approvalPolicy") result.approvalPolicy = target as CodexApprovalPolicy;
    else result.sandbox = target as CodexSandbox;
  }
  return result;
}

function sandboxEcho(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  const thread = isRecord(result.thread) ? result.thread : null;
  const value = thread?.sandbox ?? result.sandbox;
  return isRecord(value) ? value : null;
}
function booleanField(value: Record<string, unknown>, key: string): boolean {
  if (value[key] !== undefined && typeof value[key] !== "boolean") fail("Codex 返回了无法核对的沙箱字段");
  return value[key] === true;
}
function roots(value: Record<string, unknown>, cwd: string): string[] {
  const raw = value.writableRoots ?? [];
  if (!Array.isArray(raw) || raw.length > 100 || raw.some(p => typeof p !== "string" || !isAbsolute(p) || p.includes("\0") || p.length > 4096)) fail("Codex 返回了无法核对的可写目录");
  // workspace-write 对 cwd 的隐式授权与显式 writableRoots 一起比较。
  return [cwd, ...raw as string[]].map(p => resolve(p));
}
/** 重启后的最终回显必须满足申请值，并且审批、网络、目录与临时目录均未放宽。 */
export function assertPolicyNotWeaker(baseline: unknown, actual: unknown, requested: PolicyOverrides, cwd: string): void {
  const before = parseEffectivePolicy(baseline), after = parseEffectivePolicy(actual);
  if (!before || !after) fail("Codex 未回传完整权限，无法确认覆盖结果");
  const approvalBefore = APPROVAL.indexOf(before.approval), approvalAfter = APPROVAL.indexOf(after.approval);
  const sandboxBefore = SANDBOX.indexOf(before.sandbox), sandboxAfter = SANDBOX.indexOf(after.sandbox);
  if ([approvalBefore, approvalAfter, sandboxBefore, sandboxAfter].some(n => n < 0)) fail("Codex 返回未知权限，无法确认覆盖结果");
  if (approvalAfter < approvalBefore || sandboxAfter < sandboxBefore) fail("Codex 实际权限比原设置更宽松");
  if (requested.approvalPolicy && requested.approvalPolicy !== after.approval) fail("Codex 未应用要求的审批策略");
  if (requested.sandbox && requested.sandbox !== after.sandbox) fail("Codex 未应用要求的文件访问策略");
  if (before.sandbox === "danger-full-access") return;
  const old = sandboxEcho(baseline), next = sandboxEcho(actual);
  if (!old || !next) fail("缺少沙箱明细，无法确认权限未放宽");
  const known = new Set(["type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]);
  if ([...Object.keys(old), ...Object.keys(next)].some(key => !known.has(key))) fail("沙箱包含尚未支持的权限维度，不能自动覆盖");
  if (booleanField(next, "networkAccess") && !booleanField(old, "networkAccess")) fail("覆盖结果放宽了网络访问");
  if (after.sandbox === "workspace-write") {
    const allowed = roots(old, cwd);
    // 只接受既有根目录；不把新增“子路径”当作安全子集，避免符号链接逃逸。
    if (roots(next, cwd).some(path => !allowed.includes(path))) fail("覆盖结果扩大了可写目录");
    for (const field of ["excludeTmpdirEnvVar", "excludeSlashTmp"]) {
      if (booleanField(old, field) && !booleanField(next, field)) fail("覆盖结果放宽了临时目录写入");
    }
  }
}
