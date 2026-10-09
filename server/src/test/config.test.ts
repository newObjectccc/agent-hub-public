/**
 * 配置安全测试：
 * 1. isSafeBindHost 归一化判定——IPv6 简写/IPv4-mapped 通配绕过一律拒绝
 * 2. CORS 同源/白名单判定（不反射任意 Origin）
 * 3. loadHubConfig：通配 host 回落 127.0.0.1；allowLan 显式 opt-in 放行；allowOrigins 白名单解析
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isAllowedCrossOrigin, isSafeBindHost, isSameOrigin, loadHubConfig } from "../config.js";

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
