/** Inherit the current environment. Login-shell startup is an explicit, side-effectful opt-in. */
import { spawnSync } from "node:child_process";
import { labError } from "./lab.mjs";

const MARKER = "__AGENT_HUB_ENV_BEGIN__";
const PREFIXES = ["OPENAI_", "CODEX_", "ANTHROPIC_", "CLAUDE_CODE_"];

export function loadShellProviderEnv({ optIn = false, env = process.env, spawn = spawnSync } = {}) {
  if (!optIn) return {};
  const result = spawn(env.SHELL ?? "/bin/zsh", ["-lic", `printf '${MARKER}'; env -0`], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000, env,
  });
  if (result.error || result.status !== 0) throw labError("SHELL_ENV_FAILED");
  const output = result.stdout ?? "";
  const at = output.lastIndexOf(MARKER);
  if (at < 0) throw labError("SHELL_ENV_MARKER_MISSING");
  const picked = {};
  for (const entry of output.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (PREFIXES.some((prefix) => key.startsWith(prefix)) && entry.slice(eq + 1) !== "") picked[key] = entry.slice(eq + 1);
  }
  return picked;
}

export function childEnv(env = process.env, options = {}) {
  return { ...env, ...loadShellProviderEnv({ env, optIn: env.CODEX_LAB_LOAD_SHELL_ENV === "1", ...options }) };
}
