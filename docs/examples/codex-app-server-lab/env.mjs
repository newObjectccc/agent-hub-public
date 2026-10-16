/**
 * 登录 shell provider env 注入（复刻 server/src/adapters/claude-env.ts 的做法）
 * 安全：只返回键值供 spawn 注入，**永不打印值**（只打印键名）。
 */
import { spawnSync } from "node:child_process";

const MARKER = "__AGENT_HUB_ENV_BEGIN__";
const PREFIXES = ["OPENAI_", "CODEX_", "ANTHROPIC_", "CLAUDE_CODE_"];

export function loadShellProviderEnv() {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const r = spawnSync(shell, ["-lic", `printf ${MARKER}; env -0`], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000,
  });
  const out = r.stdout ?? "";
  const at = out.lastIndexOf(MARKER);
  const body = at >= 0 ? out.slice(at + MARKER.length) : out;
  const picked = {};
  for (const entry of body.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (PREFIXES.some((p) => key.startsWith(p)) && value !== "") picked[key] = value;
  }
  return picked;
}

export function keyNames(env) {
  return Object.keys(env).sort().join(",");
}
