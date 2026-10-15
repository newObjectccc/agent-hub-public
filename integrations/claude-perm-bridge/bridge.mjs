#!/usr/bin/env node
/**
 * claude-perm-bridge：Claude Code MCP permission-prompt-tool 的 stdio 桥（单文件自包含，运行期零依赖）。
 *
 * 作用（E2 实验实测契约，docs/CLAUDE_DRIVER.md）：hub 驱动的 claude 会话需要权限确认时，
 * Claude Code 以 MCP tools/call 调本工具 → 转发 agent-hub（HTTP 回环）→ 手机端批准/拒绝 →
 * 以唯一合法的 PermissionResult 形状回注（content[0].text = JSON，message 必填）。
 *
 * 线格式（E2 实测，claude 2.1.267）：
 * - 请求：{"method":"tools/call","params":{"name":"permission_prompt","arguments":{
 *     "tool_name":"Bash","input":{...},"tool_use_id":"call_..."}}}
 * - 应答：{"content":[{"type":"text","text":"{\"behavior\":\"allow\",\"updatedInput\":{...},\"message\":\"\"}"}],"isError":false}
 *
 * 环境变量（driver spawn claude 时注入，本进程继承）：
 * - AGENT_HUB_SESSION_ID  必填：所属会话 id
 * - AGENT_HUB_LIVE_URL    hub 地址（默认 http://127.0.0.1:7700）
 * - AGENT_HUB_LIVE_TOKEN  非空时带 Authorization: Bearer（与 server auth.token 对齐）
 *
 * 硬性要求（与 pi-command 同铁律）：
 * - 任何异常静默吞掉：无法联系 hub 一律 deny（安全默认，绝不卡死 claude）
 * - 30 分钟 HTTP 超时上限（人可能慢，但 MCP 调用不能永久挂）
 */
import { appendFileSync } from "node:fs";

const DEFAULT_LIVE_URL = "http://127.0.0.1:7700";
const HUB_TIMEOUT_MS = 30 * 60_000;

const SESSION_ID = process.env.AGENT_HUB_SESSION_ID ?? "";
const BASE_URL = (process.env.AGENT_HUB_LIVE_URL ?? DEFAULT_LIVE_URL).replace(/\/+$/, "");
const TOKEN = process.env.AGENT_HUB_LIVE_TOKEN ?? "";
const DEBUG_LOG = process.env.AGENT_HUB_BRIDGE_LOG ?? "";

function log(line) {
  if (DEBUG_LOG === "") return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 静默 */
  }
}

/** hub 应答 → PermissionResult（唯一合法形状：text JSON + message 必填） */
function permissionResult(behavior, originalInput, message) {
  const perm =
    behavior === "allow"
      ? { behavior: "allow", updatedInput: originalInput, message: "" }
      : { behavior: "deny", updatedInput: originalInput, message: message || "denied" };
  return { content: [{ type: "text", text: JSON.stringify(perm) }], isError: false };
}

async function askHub(args) {
  const body = {
    sessionId: SESSION_ID,
    requestId: typeof args.tool_use_id === "string" && args.tool_use_id !== "" ? args.tool_use_id : `req-${Date.now()}`,
    toolName: typeof args.tool_name === "string" ? args.tool_name : "unknown",
    toolUseId: typeof args.tool_use_id === "string" ? args.tool_use_id : "",
    input: args.input ?? null,
    description: typeof args.description === "string" ? args.description : undefined,
  };
  if (SESSION_ID === "") {
    log("no AGENT_HUB_SESSION_ID, deny");
    return { behavior: "deny", message: "bridge missing session id" };
  }
  const headers = { "content-type": "application/json" };
  if (TOKEN !== "") headers.authorization = `Bearer ${TOKEN}`;
  try {
    const res = await fetch(`${BASE_URL}/api/agents/host-requests`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) ?? {};
    if (!res.ok) {
      log(`hub ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      return { behavior: "deny", message: `hub rejected (${res.status})` };
    }
    const behavior = json.behavior === "allow" ? "allow" : "deny";
    log(`hub decided ${behavior} for ${body.requestId}`);
    return { behavior, message: typeof json.message === "string" ? json.message : "" };
  } catch (err) {
    log(`hub unreachable: ${err?.message ?? err}`);
    return { behavior: "deny", message: "hub unreachable" };
  }
}

// ---- MCP stdio（换行分隔 JSON-RPC）----

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\n");
    if (line === "") continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(msg);
  }
});

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  try {
    if (method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-hub-perm", version: "1.0.0" },
        },
      });
    } else if (typeof method === "string" && method.startsWith("notifications/")) {
      /* 通知无回执 */
    } else if (method === "tools/list") {
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "permission_prompt",
              description: "Ask the operator to approve or deny a tool permission request",
              inputSchema: {
                type: "object",
                properties: {
                  tool_name: { type: "string" },
                  input: { type: "object" },
                  tool_use_id: { type: "string" },
                  description: { type: "string" },
                },
                required: ["tool_name", "input"],
              },
            },
          ],
        },
      });
    } else if (method === "tools/call") {
      const args = params?.arguments ?? {};
      log(`tools/call ${JSON.stringify(args).slice(0, 300)}`);
      const decision = await askHub(args);
      reply({
        jsonrpc: "2.0",
        id,
        result: permissionResult(decision.behavior, args.input, decision.message),
      });
    } else if (id !== undefined) {
      reply({ jsonrpc: "2.0", id, result: {} });
    }
  } catch (err) {
    log(`handle error: ${err?.message ?? err}`);
    if (id !== undefined) {
      // 出错一律 deny，绝不让 claude 挂死
      reply({ jsonrpc: "2.0", id, result: permissionResult("deny", null, "bridge error") });
    }
  }
}
