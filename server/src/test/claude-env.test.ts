/**
 * claude-env 单测：自定义 provider 环境的合并与 shell 输出解析。
 * 不真跑用户 shell（SHELL 指向不存在的路径，快速降级）。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  loadClaudeProviderEnv,
  mergeClaudeEnv,
  mergeClaudeEnvSync,
  parseShellEnvOutput,
  resetClaudeEnvCache,
} from "../adapters/claude-env.js";

const MARKER = "__AGENT_HUB_ENV_BEGIN__";

let home = "";
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;

beforeEach(() => {
  resetClaudeEnvCache();
});

after(async () => {
  process.env.HOME = originalHome;
  process.env.SHELL = originalShell;
  if (home) await rm(home, { recursive: true, force: true });
});

async function fakeHome(settings?: Record<string, unknown>): Promise<string> {
  home = await mkdtemp(join(tmpdir(), "agh-env-"));
  process.env.HOME = home;
  process.env.SHELL = "/nonexistent-shell"; // shell 读取快速失败 → 空
  if (settings) {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify(settings),
    );
  }
  return home;
}

describe("parseShellEnvOutput", () => {
  it("keeps only provider keys after the marker", () => {
    const noise = "Welcome to zsh!\ncompinit warning\n";
    const body = [
      "ANTHROPIC_BASE_URL=https://gateway.example/v1",
      "ANTHROPIC_API_KEY=sk-secret",
      "PATH=/usr/bin",
      "EMPTY_KEY=",
    ].join("\0");
    const parsed = parseShellEnvOutput(
      `${noise}${MARKER}\n${body}\0`,
    );
    assert.deepEqual(parsed, {
      ANTHROPIC_BASE_URL: "https://gateway.example/v1",
      ANTHROPIC_API_KEY: "sk-secret",
    });
  });

  it("drops rc noise that looks like assignments before the marker", () => {
    const parsed = parseShellEnvOutput(
      `ANTHROPIC_API_KEY=evil-echo\n${MARKER}\nANTHROPIC_MODEL=m1\0`,
    );
    assert.deepEqual(parsed, { ANTHROPIC_MODEL: "m1" });
  });

  it("supports OPENAI_ keys for codex", () => {
    const parsed = parseShellEnvOutput(
      `${MARKER}\nOPENAI_BASE_URL=https://gw.example\0`,
    );
    assert.equal(parsed.OPENAI_BASE_URL, "https://gw.example");
  });
});

describe("loadClaudeProviderEnv", () => {
  it("reads env from ~/.claude/settings.json and settings.local.json", async () => {
    await fakeHome({
      env: {
        ANTHROPIC_BASE_URL: "https://settings.example",
        ANTHROPIC_API_KEY: "k1",
        NODE_ENV: "should-not-pass",
      },
    });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({ env: { ANTHROPIC_MODEL: "local-model" } }),
    );
    const env = await loadClaudeProviderEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, "https://settings.example");
    assert.equal(env.ANTHROPIC_API_KEY, "k1");
    assert.equal(env.ANTHROPIC_MODEL, "local-model");
    assert.equal(env.NODE_ENV, undefined);
  });

  it("survives missing or broken settings", async () => {
    await fakeHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not json");
    const env = await loadClaudeProviderEnv();
    assert.deepEqual(env, {});
  });
});

describe("mergeClaudeEnv", () => {
  it("lets explicit process env win, but fills blanks from provider env", async () => {
    await fakeHome({
      env: {
        ANTHROPIC_BASE_URL: "https://settings.example",
        ANTHROPIC_MODEL: "from-settings",
      },
    });
    await loadClaudeProviderEnv();
    const merged = await mergeClaudeEnv({
      ANTHROPIC_BASE_URL: "https://explicit.example",
      ANTHROPIC_MODEL: "",
      UNRELATED: "x",
    });
    assert.equal(merged.ANTHROPIC_BASE_URL, "https://explicit.example");
    assert.equal(merged.ANTHROPIC_MODEL, "from-settings");
    assert.equal(merged.UNRELATED, "x");
  });

  it("mergeClaudeEnvSync uses the warmed cache", async () => {
    await fakeHome({ env: { ANTHROPIC_MODEL: "cached-model" } });
    await loadClaudeProviderEnv();
    const merged = mergeClaudeEnvSync({});
    assert.equal(merged.ANTHROPIC_MODEL, "cached-model");
  });

  it("mergeClaudeEnvSync without cache falls back to the process env", () => {
    resetClaudeEnvCache();
    const merged = mergeClaudeEnvSync({ ANTHROPIC_MODEL: "m" });
    assert.equal(merged.ANTHROPIC_MODEL, "m");
  });
});
