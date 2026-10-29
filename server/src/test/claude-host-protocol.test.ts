/**
 * claude-host-protocol 纯函数单测（docs/CLAUDE_DRIVER.md E2/E3/E4 实测契约）。
 * 重点固化：spawn 参数安全集（绝不含危险 flag）、权限应答唯一合法形状、bridge 请求校验。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDriverArgs,
  buildMcpConfigJson,
  encodeInterrupt,
  encodePermissionResult,
  encodeUserMessage,
  hostRequestTitle,
  isBypassSettings,
  parseBridgeHostRequestBody,
  parseDriverMode,
  PERM_TOOL_FULL_NAME,
} from "../adapters/claude-host-protocol.js";

describe("buildDriverArgs：spawn 参数安全集", () => {
  it("基础参数含 stream-json 双向 + --resume + verbose", () => {
    const args = buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null });
    assert.deepEqual(args.slice(0, 7), ["-p", "--resume", "s-1", "--input-format", "stream-json", "--output-format", "stream-json"]);
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
  });

  it("绝不含危险 flag（--dangerously-skip-permissions / --allowedTools / --bare），与权限档位无关", () => {
    for (const mode of ["manual", "bypassPermissions"]) {
      const args = buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: "/x/bridge.mjs", permissionMode: mode });
      const joined = args.join(" ");
      assert.ok(!joined.includes("dangerously"));
      assert.ok(!joined.includes("allowedTools"));
      assert.ok(!joined.includes("allowed-tools"));
      assert.ok(!joined.includes("--bare"));
    }
  });

  it("permissionMode 白名单校验：五个 CLI 档位全部通过且值正确；非法档位拒绝，不透传 CLI", () => {
    for (const mode of ["bypassPermissions", "manual", "default", "acceptEdits", "plan"]) {
      const args = buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null, permissionMode: mode });
      const i = args.indexOf("--permission-mode");
      assert.ok(i > 0, `合法档位 ${mode} 必须下发 flag`);
      assert.equal(args[i + 1], mode);
    }
    assert.throws(() => buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null, permissionMode: "bypass" }), /非法/);
    assert.throws(() => buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null, permissionMode: "inherit" }), /非法/);
    assert.throws(() => buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null, permissionMode: "--evil-flag" }), /非法/);
  });

  it("bridge 路径非空时挂 --permission-prompts host + 全名工具 + --mcp-config", () => {
    const args = buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: "/x/bridge.mjs" });
    const i = args.indexOf("--permission-prompt-tool");
    assert.ok(i > 0);
    assert.equal(args[i + 1], PERM_TOOL_FULL_NAME);
    assert.ok(args.includes("--permission-prompts"));
    const j = args.indexOf("--mcp-config");
    const cfg = JSON.parse(args[j + 1]);
    assert.equal(typeof cfg.mcpServers.permhook.command, "string");
    assert.deepEqual(cfg.mcpServers.permhook.args, ["/x/bridge.mjs"]);
  });

  it("默认 bypass 运行：bridge 为 null 不挂权限通道", () => {
    const args = buildDriverArgs({ sessionId: "s-1", bridgeScriptPath: null, permissionMode: "bypassPermissions" });
    assert.ok(!args.includes("--permission-prompt-tool"));
    assert.ok(!args.includes("--mcp-config"));
    const i = args.indexOf("--permission-mode");
    assert.ok(i > 0);
    assert.equal(args[i + 1], "bypassPermissions");
  });

  it("buildMcpConfigJson 可解析且指向脚本路径", () => {
    const cfg = JSON.parse(buildMcpConfigJson("/abs/bridge.mjs"));
    assert.deepEqual(cfg.mcpServers.permhook.args, ["/abs/bridge.mjs"]);
  });
});

describe("消息/中断线格式（E3/E4 实测）", () => {
  it("encodeUserMessage 形状", () => {
    assert.equal(
      encodeUserMessage("hello"),
      '{"type":"user","message":{"role":"user","content":"hello"}}',
    );
  });

  it("encodeInterrupt 形状（control_request subtype:interrupt）", () => {
    const row = JSON.parse(encodeInterrupt("req-abc"));
    assert.deepEqual(row, {
      type: "control_request",
      request_id: "req-abc",
      request: { subtype: "interrupt" },
    });
  });
});

describe("encodePermissionResult：E2 唯一合法形状", () => {
  it("allow：content[0].text 为 JSON 且 message 必填空串", () => {
    const res = encodePermissionResult("allow", { command: "ls" });
    assert.equal(res.isError, false);
    const perm = JSON.parse(res.content[0].text);
    assert.equal(perm.behavior, "allow");
    assert.equal(perm.message, "");
    assert.deepEqual(perm.updatedInput, { command: "ls" });
  });

  it("deny：message 非空（缺省给兜底文案）", () => {
    const res = encodePermissionResult("deny", null);
    const perm = JSON.parse(res.content[0].text);
    assert.equal(perm.behavior, "deny");
    assert.notEqual(perm.message, "");
    const res2 = encodePermissionResult("deny", null, "user said no");
    assert.equal(JSON.parse(res2.content[0].text).message, "user said no");
  });
});

describe("parseBridgeHostRequestBody", () => {
  it("合法请求归一（requestId 缺省回落 toolUseId）", () => {
    const parsed = parseBridgeHostRequestBody({
      sessionId: "s1",
      toolName: "Bash",
      toolUseId: "call_1",
      input: { command: "ls" },
    });
    assert.ok(parsed);
    assert.equal(parsed.requestId, "call_1");
    assert.equal(parsed.toolName, "Bash");
  });

  it("缺关键字段返回 null", () => {
    assert.equal(parseBridgeHostRequestBody({ sessionId: "s1" }), null);
    assert.equal(parseBridgeHostRequestBody("x"), null);
    assert.equal(parseBridgeHostRequestBody(null), null);
  });

  it("hostRequestTitle 摘要取 command/file_path 优先", () => {
    assert.equal(hostRequestTitle("Bash", { command: "rm -rf /tmp/x" }), "Bash: rm -rf /tmp/x");
    assert.equal(hostRequestTitle("Read", { file_path: "/a/b.ts" }), "Read: /a/b.ts");
  });
});

describe("isBypassSettings / parseDriverMode", () => {
  // 注意：默认策略（bypassPermissions）由配置直接决定、不依赖本判定；
  // isBypassSettings 仅在 permissionMode=inherit（沿用 settings）时消费，语义是「settings 显式才算 bypass」。
  it("bypassPermissions 判定", () => {
    assert.equal(isBypassSettings({ permissions: { defaultMode: "bypassPermissions" } }), true);
    assert.equal(isBypassSettings({ permissions: { defaultMode: "acceptEdits" } }), false);
    assert.equal(isBypassSettings({}), false);
    assert.equal(isBypassSettings(null), false);
  });

  it("mode 解析与拒绝", () => {
    assert.equal(parseDriverMode("steer"), "steer");
    assert.equal(parseDriverMode(undefined), "prompt");
    assert.throws(() => parseDriverMode("x"), /prompt\|steer\|followUp/);
  });
});
