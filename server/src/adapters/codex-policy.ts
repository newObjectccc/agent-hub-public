/** 仅依赖协议回显比较权限；不读取用户配置、凭据或运行模型。 */
import type { CodexDriverConfig } from "../config.js";
import { isAbsolute, resolve } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import { isRecord } from "./codex-rpc.js";
import { parseEffectivePolicy, type CodexApprovalPolicy, type CodexSandbox } from "./codex-host-protocol.js";
export interface PolicyOverrides { approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandbox }
const APPROVAL = ["never", "on-request", "untrusted"];
const SANDBOX = ["danger-full-access", "workspace-write", "read-only"];
function fail(message: string): never { throw new HubError(ErrorCodes.INVALID_REQUEST, `${message}；本次接管已停止，未执行任务。可改为 inherit 沿用电脑端设置`, 400); }

/** 两条通道统一从 Hub 配置取得策略；inherit 不产生任何覆盖。 */
export function configuredCodexPolicy(config: Pick<CodexDriverConfig, "approvalPolicy" | "sandbox">): PolicyOverrides {
  return {
    ...(config.approvalPolicy === "inherit" ? {} : { approvalPolicy: config.approvalPolicy }),
    ...(config.sandbox === "inherit" ? {} : { sandbox: config.sandbox }),
  };
}

/** CLI 的逐进程 TOML 配置覆盖，不修改用户 config.toml，也不经 shell。 */
export function buildExecPolicyArgs(policy: PolicyOverrides): string[] {
  return Object.entries(policy).flatMap(([key, value]) => value === undefined ? [] :
    ["-c", `${key === "approvalPolicy" ? "approval_policy" : "sandbox_mode"}=${JSON.stringify(value)}`]);
}

/** 初次恢复取得基线；明确配置可放宽或收紧，实际回显另行核验。 */
export function planPolicyOverrides(baseline: unknown, requested: PolicyOverrides): PolicyOverrides {
  const policy = parseEffectivePolicy(baseline);
  const result: PolicyOverrides = {};
  for (const [key, field, ranks] of [["approvalPolicy", "approval", APPROVAL], ["sandbox", "sandbox", SANDBOX]] as const) {
    const target = requested[key];
    if (target === undefined) continue;
    const original = policy?.[field] ?? "unknown";
    if (original === target) continue;
    if (!ranks.includes(target)) fail("配置的 Codex 权限不是受支持的策略");
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
/** 最终回显必须满足显式申请；未覆盖的维度及其细粒度限制不能顺便放宽。 */
export function assertPolicyApplied(baseline: unknown, actual: unknown, requested: PolicyOverrides, cwd: string): void {
  const before = parseEffectivePolicy(baseline), after = parseEffectivePolicy(actual);
  if (!after || !APPROVAL.includes(after.approval) || !SANDBOX.includes(after.sandbox)) fail("Codex 未回传完整权限，无法确认覆盖结果");
  for (const [key, field] of [["approvalPolicy", "approval"], ["sandbox", "sandbox"]] as const) {
    if (requested[key] !== undefined) {
      if (requested[key] !== after[field]) fail(`Codex 未应用要求的${key === "approvalPolicy" ? "审批" : "文件访问"}策略`);
    } else if (!before || before[field] === "unknown" || before[field] !== after[field]) {
      fail("Codex 改变了未申请覆盖的权限维度，无法确认继承结果");
    }
  }
  // 明确申请更宽的沙箱就是用户授权的范围，不再与旧基线比较；未覆盖维度已在上方核对。
  if (requested.sandbox !== undefined && (!before || !SANDBOX.includes(before.sandbox) || SANDBOX.indexOf(after.sandbox) < SANDBOX.indexOf(before.sandbox))) return;
  if (before?.sandbox === "danger-full-access") return;
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
