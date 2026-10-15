/**
 * claude-host-protocol：hub 驱动 claude 会话的协议编解码纯函数（无 IO，独立可测）。
 *
 * 契约来源：docs/CLAUDE_DRIVER.md（Phase 0 实验实测，claude CLI 2.1.267）：
 * - stdin 用户消息 / control interrupt 的线格式（E3/E4 实测）
 * - 权限应答走 `--permission-prompt-tool` + 自带 MCP bridge（E2 实测）：
 *   请求 = MCP tools/call {tool_name, input, tool_use_id}；
 *   应答 = content[0].text 为 JSON 字符串且 message 字段必填（allow 空串）。
 * - 裸 CLI `--permission-prompts host` 不产生 control_request（无人应答自动拒），
 *   故 bridge 是唯一官方应答通道；bypass 环境不产生请求，bridge 空转无害。
 */
import { ErrorCodes, HubError } from "../errors.js";

/** MCP bridge server 名与工具名（全名 mcp__<server>__<tool>，E2 实测必须全名） */
export const PERM_MCP_SERVER = "permhook";
export const PERM_MCP_TOOL = "permission_prompt";
export const PERM_TOOL_FULL_NAME = `mcp__${PERM_MCP_SERVER}__${PERM_MCP_TOOL}`;

/** 环境变量约定（与 pi-command 扩展同名对齐）：bridge 据此回连 hub */
export const ENV_LIVE_URL = "AGENT_HUB_LIVE_URL";
export const ENV_LIVE_TOKEN = "AGENT_HUB_LIVE_TOKEN";
export const ENV_SESSION_ID = "AGENT_HUB_SESSION_ID";

/** 驱动 spawn 参数组装（固定安全集：绝不带 --dangerously-skip-permissions / --allowedTools / --bare） */
export interface DriverArgsInput {
  sessionId: string;
  /** permission-prompt-tool bridge 脚本绝对路径；null = 不挂 bridge（bypass 环境） */
  bridgeScriptPath: string | null;
  /** 显式 --permission-mode 覆盖；undefined = 继承 settings（推荐，与终端体验一致） */
  permissionMode?: string;
}

export function buildDriverArgs(input: DriverArgsInput): string[] {
  const args = [
    "-p",
    "--resume",
    input.sessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (input.bridgeScriptPath !== null) {
    args.push(
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      PERM_TOOL_FULL_NAME,
      "--mcp-config",
      buildMcpConfigJson(input.bridgeScriptPath),
    );
  }
  if (input.permissionMode !== undefined && input.permissionMode !== "") {
    args.push("--permission-mode", input.permissionMode);
  }
  return args;
}

/** --mcp-config 内联 JSON（bridge 为单文件 node 脚本，运行期零依赖） */
export function buildMcpConfigJson(bridgeScriptPath: string): string {
  return JSON.stringify({
    mcpServers: {
      [PERM_MCP_SERVER]: {
        command: process.execPath,
        args: [bridgeScriptPath],
      },
    },
  });
}

/** stdin 用户消息行（E3 实测：真用户 turn，多条顺序写入即多轮） */
export function encodeUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

/** E4 实测：control interrupt —— turn 以 error_during_execution 收尾，进程存活 */
export function encodeInterrupt(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
}

export type PermissionBehavior = "allow" | "deny";

/**
 * E2 实测唯一合法的 MCP 应答形状：content[0].text 为 JSON 字符串，message 必填（allow 空串）。
 * 其余形状（平铺 PermissionResult / 纯 "allow" 文本）报「格式非法」被拒。
 */
export function encodePermissionResult(behavior: PermissionBehavior, originalInput: unknown, message = ""): {
  content: Array<{ type: "text"; text: string }>;
  isError: false;
} {
  const perm =
    behavior === "allow"
      ? { behavior: "allow", updatedInput: originalInput, message: "" }
      : { behavior: "deny", updatedInput: originalInput, message: message !== "" ? message : "denied by operator" };
  return { content: [{ type: "text", text: JSON.stringify(perm) }], isError: false };
}

/** bridge → hub 的权限请求体（POST /api/agents/host-requests） */
export interface BridgeHostRequestBody {
  sessionId: string;
  /** 幂等键 = tool_use_id（claude 侧全局唯一） */
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: unknown;
  description?: string;
}

/** 校验并归一 bridge 请求体；非法返回 null（bridge 契约宽松，缺字段按空串兜底） */
export function parseBridgeHostRequestBody(raw: unknown): BridgeHostRequestBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
  const toolUseId = typeof o.toolUseId === "string" ? o.toolUseId : "";
  const requestId = typeof o.requestId === "string" && o.requestId !== "" ? o.requestId : toolUseId;
  const toolName = typeof o.toolName === "string" ? o.toolName : "";
  if (sessionId === "" || requestId === "" || toolName === "") return null;
  return {
    sessionId,
    requestId,
    toolName,
    toolUseId,
    input: o.input ?? null,
    description: typeof o.description === "string" ? o.description : undefined,
  };
}

/** 权限请求标题（手机卡片）：工具名 + 入参摘要 */
export function hostRequestTitle(toolName: string, input: unknown): string {
  const preview = summarizeInput(input);
  return preview === "" ? toolName : `${toolName}: ${preview}`;
}

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "url", "pattern", "query"]) {
    const v = o[key];
    if (typeof v === "string" && v !== "") return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  }
  try {
    const s = JSON.stringify(o);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  } catch {
    return "";
  }
}

/**
 * 解析是否 bypass 环境（settings permissions.defaultMode = bypassPermissions）。
 * 命中 → 权限请求根本不产生（E2 实测），驱动可不挂 bridge。
 * settings 结构容错：任何异常按非 bypass 处理（挂 bridge 空转无害）。
 */
export function isBypassSettings(settingsJson: unknown): boolean {
  if (typeof settingsJson !== "object" || settingsJson === null) return false;
  const perms = (settingsJson as Record<string, unknown>).permissions;
  if (typeof perms !== "object" || perms === null) return false;
  return (perms as Record<string, unknown>).defaultMode === "bypassPermissions";
}

/** mode 解析（缺省 = prompt；非法值抛 400，文案与 agents.ts parseMode 一致） */
export function parseDriverMode(raw: unknown): "prompt" | "steer" | "followUp" {
  if (raw === undefined) return "prompt";
  if (raw === "prompt" || raw === "steer" || raw === "followUp") return raw;
  throw new HubError(ErrorCodes.INVALID_REQUEST, "mode 必须是 prompt|steer|followUp 之一");
}
