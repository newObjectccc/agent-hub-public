/**
 * 配置安全测试：
 * 1. isSafeBindHost 归一化判定——IPv6 简写/IPv4-mapped 通配绕过一律拒绝
 * 2. CORS 同源/白名单判定（不反射任意 Origin）
 * 3. loadHubConfig：通配 host 回落 127.0.0.1；allowLan 显式 opt-in 放行；allowOrigins 白名单解析
 * 4. loadHubConfig claudeDriver：enabled===false 解析生效；defaultPolicy 非法值回 active-only
 * 5. loadHubConfig auth：非法结构/类型与 enabled=true 但 token 空 → 启动前拒绝
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_CLAUDE_DRIVER_CONFIG,
  DEFAULT_CODEX_DRIVER_CONFIG,
  isAllowedCrossOrigin,
  isSafeBindHost,
  isSameOrigin,
  loadHubConfig,
} from "../config.js";

describe("Codex 运行时配置", () => {
  const load = (raw: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "hub-codex-config-"));
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify(raw));
    return { ...loadHubConfig(dir, "/example/home"), dir };
  };
  it("默认仅手动接管；配置对象互不共享", () => {
    const first = load({});
    assert.equal(first.config.codexBin, "codex");
    assert.deepEqual(first.config.codexDriver, DEFAULT_CODEX_DRIVER_CONFIG);
    assert.equal(first.config.codexDriver.approvalPolicy, "never");
    assert.equal(first.config.codexDriver.sandbox, "danger-full-access");
    first.config.codexDriver.enabled = false;
    assert.equal(load({}).config.codexDriver.enabled, true);
  });
  it("命令名保留 PATH，路径按配置目录展开，支持空格", () => {
    assert.equal(load({ codexBin: "custom-codex" }).config.codexBin, "custom-codex");
    assert.equal(load({ codexBin: "~/Applications/Codex App/codex" }).config.codexBin, "/example/home/Applications/Codex App/codex");
    const { config, dir } = load({ codexBin: "./tools/my codex" });
    assert.equal(config.codexBin, join(dir, "tools/my codex"));
  });
  it("非法值回默认并告警，不接受空字符串/换行或无界定时配置", () => {
    const { config, warnings } = load({ codexBin: "codex\ncommand", codexDriver: { maxConcurrent: 0.5, idleDetachMs: 3e9, defaultPolicy: "active" } });
    assert.equal(config.codexBin, "codex");
    assert.deepEqual(config.codexDriver, DEFAULT_CODEX_DRIVER_CONFIG);
    assert.equal(warnings.length, 4);
  });
  it("最高权限、收紧与 inherit 都可显式选择", () => {
    for (const approvalPolicy of ["never", "inherit", "untrusted", "on-request"]) {
      assert.equal(load({ codexDriver: { approvalPolicy } }).config.codexDriver.approvalPolicy, approvalPolicy);
    }
    for (const sandbox of ["danger-full-access", "inherit", "read-only", "workspace-write"]) {
      assert.equal(load({ codexDriver: { sandbox } }).config.codexDriver.sandbox, sandbox);
    }
  });
  it("Codex 权限字段错误拒绝启动，不回落最高权限", () => {
    for (const codexDriver of [null, [], "auto", { approvalPolicy: "nevver" }, { sandbox: "readOnly" },
      { approvalPolicy: null }, { sandbox: 42 }, { approvalPolcy: "untrusted" }, { sandbox_mode: "read-only" }]) {
      assert.throws(() => load({ codexDriver }), { code: "CONFIG_INVALID" });
    }
  });
  it("关闭开关和显式策略逐项生效", () => {
    const { config, warnings } = load({ codexDriver: { enabled: false, defaultPolicy: "always", maxConcurrent: 1, idleDetachMs: 0, externalQuietMs: 0, approvalPolicy: "on-request", sandbox: "workspace-write" } });
    assert.deepEqual(config.codexDriver, { enabled: false, defaultPolicy: "always", maxConcurrent: 1, idleDetachMs: 0, externalQuietMs: 0, approvalPolicy: "on-request", sandbox: "workspace-write" });
    assert.deepEqual(warnings, []);
  });
});

describe("config: isSafeBindHost 归一化判定（防通配绑定绕过）", () => {
  it("拒绝全部通配/未指定地址写法（含 IPv6 简写与 IPv4-mapped）", () => {
    for (const host of [
      "",
      "   ",
      "*",
      "0.0.0.0",
      "::",
      "[::]",
      "::0",
      "0:0:0:0:0:0:0:0",
      "0:0::0",
      "::ffff:0.0.0.0",
      "::ffff:0:0",
      "::FFFF:0.0.0.0",
    ]) {
      assert.equal(isSafeBindHost(host), false, `必须拒绝: ${JSON.stringify(host)}`);
    }
  });

  it("允许具体地址与主机名（loopback / 单播 IP / hostname）", () => {
    for (const host of ["127.0.0.1", "192.168.1.10", "::1", "[::1]", "localhost", "::ffff:127.0.0.1", "my-host.local"]) {
      assert.equal(isSafeBindHost(host), true, `必须允许: ${JSON.stringify(host)}`);
    }
  });
});

describe("config: CORS 同源 / 白名单判定", () => {
  it("isSameOrigin：host[:port] 一致才算同源（默认端口归一化 + 连接协议校验）", () => {
    assert.equal(isSameOrigin("http://a.com", "a.com"), true);
    assert.equal(isSameOrigin("http://a.com:7700", "a.com:7700"), true);
    assert.equal(isSameOrigin("http://a.com:80", "a.com"), true);
    assert.equal(isSameOrigin("https://a.com", "a.com:443"), true);
    assert.equal(isSameOrigin("http://a.com", "a.com:7700"), false, "端口不同非同源");
    assert.equal(isSameOrigin("https://a.com", "a.com", "https"), true);
    assert.equal(isSameOrigin("https://a.com", "a.com", "http"), false, "scheme 不同非同源（按连接协议判定）");
    // 本机 dev proxy（Vite 5173 → 7700）：回环 ↔ 回环视同同源
    assert.equal(isSameOrigin("http://localhost:5173", "127.0.0.1:7700", "http"), true, "本机 dev proxy 同源");
    assert.equal(isSameOrigin("http://127.0.0.1:5173", "localhost:7700", "http"), true);
    assert.equal(isSameOrigin("http://localhost:5173", "192.168.1.10:7700", "http"), false, "远程访问不放宽");
    assert.equal(isSameOrigin("https://evil.com", "127.0.0.1:7700", "http"), false, "公网 Origin 不得冒充 dev 场景");
    assert.equal(isSameOrigin("null", "a.com"), false);
    assert.equal(isSameOrigin(undefined, "a.com"), false);
    assert.equal(isSameOrigin("http://a.com", undefined), false);
    assert.equal(isSameOrigin("http://evil.com", "a.com"), false);
  });

  it("isAllowedCrossOrigin：白名单精确匹配；默认空数组拒绝一切跨域", () => {
    assert.equal(isAllowedCrossOrigin("https://app.example.com", []), false, "空白名单 = 拒绝跨域");
    assert.equal(isAllowedCrossOrigin(undefined, ["https://app.example.com"]), false);
    assert.equal(isAllowedCrossOrigin("https://app.example.com", ["https://app.example.com"]), true);
    assert.equal(isAllowedCrossOrigin("HTTPS://APP.EXAMPLE.COM", ["https://app.example.com"]), true);
    assert.equal(isAllowedCrossOrigin("https://app.example.com.evil.com", ["https://app.example.com"]), false);
    assert.equal(isAllowedCrossOrigin("https://evil.com", ["https://app.example.com"]), false);
  });
});

describe("config: loadHubConfig 通配 host 与 allowLan / allowOrigins", () => {
  function loadWith(json: Record<string, unknown>): ReturnType<typeof loadHubConfig> {
    const dir = mkdtempSync(join(tmpdir(), "hub-config-"));
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify(json), "utf8");
    return loadHubConfig(dir);
  }

  it("通配 host（含 ::0 简写）回落 127.0.0.1 并告警", () => {
    for (const host of ["0.0.0.0", "::0", "::ffff:0.0.0.0"]) {
      const { config, warnings } = loadWith({ host });
      assert.equal(config.host, "127.0.0.1", `通配 host ${host} 必须回落`);
      assert.ok(warnings.some((w) => w.includes("allowLan")), "告警应指引 allowLan 显式确认");
    }
  });

  it("allowLan: true 显式确认后放行通配绑定（--lan opt-in 语义）", () => {
    const { config, warnings } = loadWith({ host: "0.0.0.0", allowLan: true });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.allowLan, true);
    assert.ok(warnings.some((w) => w.includes("监听所有网络接口")), "必须有暴露面告警");
  });

  it("具体 host 不受影响；allowOrigins 白名单解析（非法条目过滤）", () => {
    const { config } = loadWith({ host: "127.0.0.1", allowOrigins: ["https://app.example.com", 42, "  "] });
    assert.equal(config.host, "127.0.0.1");
    assert.deepEqual(config.allowOrigins, ["https://app.example.com"]);
    const bad = loadWith({ allowOrigins: "https://app.example.com" });
    assert.deepEqual(bad.config.allowOrigins, [], "非数组一律忽略（跨域全部拒绝）");
    assert.equal(bad.config.allowLan, false);
  });
});

describe("config: loadHubConfig claudeDriver 开关与默认策略解析", () => {
  function loadWith(json: Record<string, unknown>): ReturnType<typeof loadHubConfig> {
    const dir = mkdtempSync(join(tmpdir(), "hub-config-"));
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify(json), "utf8");
    return loadHubConfig(dir);
  }

  it("claudeDriver.enabled===false 解析生效（总开关：接管路由回 400，前端回落 parallel）", () => {
    const off = loadWith({ claudeDriver: { enabled: false } });
    assert.equal(off.config.claudeDriver.enabled, false);
    // 同对象其余字段回默认（逐字段校验容错，不阻断启动）
    assert.equal(off.config.claudeDriver.defaultPolicy, DEFAULT_CLAUDE_DRIVER_CONFIG.defaultPolicy);
    assert.equal(off.config.claudeDriver.maxConcurrent, DEFAULT_CLAUDE_DRIVER_CONFIG.maxConcurrent);
    // 缺省 / 显式 true 均为启用
    assert.equal(loadWith({}).config.claudeDriver.enabled, true);
    assert.equal(loadWith({ claudeDriver: { enabled: true } }).config.claudeDriver.enabled, true);
  });

  it("defaultPolicy：always/never 保留；非法值回 active-only", () => {
    assert.equal(loadWith({ claudeDriver: { defaultPolicy: "always" } }).config.claudeDriver.defaultPolicy, "always");
    assert.equal(loadWith({ claudeDriver: { defaultPolicy: "never" } }).config.claudeDriver.defaultPolicy, "never");
    assert.equal(loadWith({}).config.claudeDriver.defaultPolicy, "active-only", "缺省 = active-only");
    for (const bad of ["", "ALWAYS", "sometimes", 42, null, true]) {
      assert.equal(
        loadWith({ claudeDriver: { defaultPolicy: bad } }).config.claudeDriver.defaultPolicy,
        "active-only",
        `非法 defaultPolicy ${JSON.stringify(bad)} 必须回 active-only`,
      );
    }
  });

  it("claudeDriver 非对象（含数组）→ 拒绝加载；数值字段非法仍回默认", () => {
    for (const badInput of ["on", [], 42, null]) {
      assert.throws(() => loadWith({ claudeDriver: badInput }), { code: "CONFIG_INVALID" });
    }
    const nums = loadWith({ claudeDriver: { idleDetachMs: -1, maxConcurrent: 0, externalQuietMs: "x" } });
    assert.equal(nums.config.claudeDriver.idleDetachMs, DEFAULT_CLAUDE_DRIVER_CONFIG.idleDetachMs);
    assert.equal(nums.config.claudeDriver.maxConcurrent, DEFAULT_CLAUDE_DRIVER_CONFIG.maxConcurrent);
    assert.equal(nums.config.claudeDriver.externalQuietMs, DEFAULT_CLAUDE_DRIVER_CONFIG.externalQuietMs);
  });

  it("permissionMode：六档合法值解析生效；缺省即最高权限 bypassPermissions", () => {
    assert.equal(loadWith({}).config.claudeDriver.permissionMode, "bypassPermissions", "缺省 = 最高权限");
    for (const mode of ["bypassPermissions", "manual", "default", "acceptEdits", "plan", "inherit"]) {
      assert.equal(
        loadWith({ claudeDriver: { permissionMode: mode } }).config.claudeDriver.permissionMode,
        mode,
        `合法档位 ${mode} 必须原样生效`,
      );
    }
  });

  it("permissionMode：非法值拒绝加载，不回落到 bypassPermissions", () => {
    for (const bad of ["manul", "mannual", "BypassPermissions", "manual ", "", 42, null, true, [], {}]) {
      assert.throws(() => loadWith({ claudeDriver: { permissionMode: bad } }), {
        code: "CONFIG_INVALID", message: /claudeDriver\.permissionMode/,
      });
    }
  });

  it("权限键拼错或放错位置时拒绝加载，注释键仍被允许", () => {
    assert.throws(() => loadWith({ claudeDriver: { permisionMode: "manual" } }), { code: "CONFIG_INVALID" });
    assert.throws(() => loadWith({ permissionMode: "manual" }), { code: "CONFIG_INVALID" });
    assert.throws(() => loadWith({ claudDriver: { permissionMode: "manual" } }), { code: "CONFIG_INVALID" });
    const commented = loadWith({ claudeDriver: { "//note": "x", permissionMode: "manual" } });
    assert.ok(!commented.warnings.some((w) => w.includes("未知键")), "注释键不应告警");
    assert.equal(commented.config.claudeDriver.permissionMode, "manual");
  });
});

describe("config: 读取或结构错误在启动前失败，不吞掉权限设置", () => {
  it("损坏 JSON、非对象顶层均返回固定配置错误，不回显内容", () => {
    const marker = "SENSITIVE_CONFIG_CONTENT_FOR_TEST_ONLY";
    for (const content of [`{\"auth\":{\"token\":\"${marker}\"`, "null", "[]", '"manual"']) {
      const dir = mkdtempSync(join(tmpdir(), "hub-config-invalid-"));
      writeFileSync(join(dir, "hub.config.json"), content);
      assert.throws(() => loadHubConfig(dir, "/example/home"), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CONFIG_INVALID");
        assert.ok(!(error as Error).message.includes(marker));
        return true;
      });
    }
  });

  it("配置存在但不可读取时拒绝加载，缺少文件时仍可使用默认配置", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-config-read-error-"));
    mkdirSync(join(dir, "hub.config.json"));
    assert.throws(() => loadHubConfig(dir), { code: "CONFIG_INVALID" });
    const missing = mkdtempSync(join(tmpdir(), "hub-config-missing-"));
    assert.equal(loadHubConfig(missing).config.claudeDriver.permissionMode, "bypassPermissions");
  });

  it("未知顶层键不会被吞掉；顶层注释仍可使用", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-config-unknown-"));
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify({ permission_mode: "manual" }));
    assert.throws(() => loadHubConfig(dir), { code: "CONFIG_INVALID" });
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify({ "//note": "comment", claudeDriver: { permissionMode: "bypassPermissions" } }));
    assert.equal(loadHubConfig(dir).config.claudeDriver.permissionMode, "bypassPermissions");
  });
});

describe("config: auth 错误配置拒绝启动", () => {
  function loadWith(json: Record<string, unknown>): ReturnType<typeof loadHubConfig> {
    const dir = mkdtempSync(join(tmpdir(), "hub-config-"));
    writeFileSync(join(dir, "hub.config.json"), JSON.stringify(json), "utf8");
    return loadHubConfig(dir);
  }

  it("开启鉴权但 token 为空、缺失或只有空白时拒绝加载", () => {
    for (const auth of [{ enabled: true }, { enabled: true, token: "" }, { enabled: true, token: "   " }]) {
      assert.throws(() => loadWith({ auth }), { code: "CONFIG_INVALID" });
    }
  });

  it("非法 auth 结构、类型和拼错的键均拒绝加载且不回显内容", () => {
    const marker = "SENSITIVE_AUTH_VALUE_FOR_TEST_ONLY";
    for (const auth of [null, [], marker, { enabled: "true", token: marker },
      { enabled: true, token: 42 }, { enabled: true, token: null },
      { enabled: false, token: {} }, { enabld: true, token: marker },
      { enabled: true, toekn: marker }, { [marker]: true }]) {
      assert.throws(() => loadWith({ auth }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CONFIG_INVALID");
        assert.ok(!(error as Error).message.includes(marker));
        return true;
      });
    }
  });

  it("默认关闭、显式关闭与有效 token 保持可用；保留 token 原文和注释", () => {
    assert.deepEqual(loadWith({}).config.auth, { enabled: false, token: "" });
    assert.deepEqual(loadWith({ auth: { enabled: false, token: "" } }).config.auth, { enabled: false, token: "" });
    assert.deepEqual(loadWith({ auth: { enabled: true, token: "valid-test-token", "//note": "comment" } }).config.auth,
      { enabled: true, token: "valid-test-token" });
  });
});
