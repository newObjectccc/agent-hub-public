/**
 * claude-env：为 spawn `claude` 补全自定义 provider 环境。
 *
 * 背景：很多用户用自建网关/第三方 provider（~/.zshrc 里 export
 * ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL 等）。
 * agent-hub 由 pm2/launchd 拉起，服务进程 env 不含 shell 配置，
 * spawn 的 claude 于是回落到官方登录态检查 → "no login"。
 *
 * 补全来源（后者覆盖前者）：
 *   1. 登录 shell（$SHELL -lic env）—— 用户 shell rc 里的 export
 *   2. ~/.claude/settings.json 与 settings.local.json 的 env 段（官方持久配置）
 *   3. 当前进程 env 里的同名键（部署者显式配置优先）
 *
 * 安全：只取 provider 相关键（ANTHROPIC_* / CLAUDE_CODE_*），永不打印值。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 允许透传给子进程的环境变量前缀（claude/codex 自定义 provider 都走环境变量） */
const ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_'];

/** 登录 shell 读取的超时（首次一次，之后走缓存） */
const SHELL_TIMEOUT_MS = 4_000;
/** 缓存 TTL：环境变更（用户改 rc）多久后自动重读 */
const CACHE_TTL_MS = 10 * 60_000;

const MARKER = '__AGENT_HUB_ENV_BEGIN__';

export type EnvMap = Record<string, string | undefined>;

function isProviderKey(key: string): boolean {
  return ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function pickProviderEnv(source: EnvMap): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isProviderKey(key) && typeof value === 'string' && value !== '')
      picked[key] = value;
  }
  return picked;
}

/** 解析 `printf MARKER; env -0` 的输出，丢弃 marker 前的 rc 噪音 */
export function parseShellEnvOutput(stdout: string): Record<string, string> {
  const markerAt = stdout.lastIndexOf(MARKER);
  const body = markerAt >= 0 ? stdout.slice(markerAt + MARKER.length) : stdout;
  const picked: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (isProviderKey(key) && value !== '') picked[key] = value;
  }
  return picked;
}

async function readSettingsEnv(): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const raw = await readFile(join(homedir(), '.claude', name), 'utf8');
      const parsed = JSON.parse(raw) as { env?: EnvMap };
      if (parsed.env && typeof parsed.env === 'object')
        Object.assign(merged, pickProviderEnv(parsed.env));
    } catch {
      /* 文件不存在或不可解析：跳过 */
    }
  }
  return merged;
}

function readShellEnv(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(
      shell,
      ['-lic', `printf '\\n%s\\n' '${MARKER}'; env -0`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    const done = () => resolve(parseShellEnvOutput(out));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.on('error', done);
    child.on('exit', done);
    setTimeout(() => {
      child.kill();
      done();
    }, SHELL_TIMEOUT_MS);
  });
}

let cache: { at: number; env: Record<string, string> } | null = null;
let inflight: Promise<Record<string, string>> | null = null;

/** 加载 provider 环境（shell + settings，进程 env 由调用方叠加） */
export async function loadClaudeProviderEnv(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.env;
  if (inflight) return inflight;
  inflight = (async () => {
    const [shellEnv, settingsEnv] = await Promise.all([
      readShellEnv(),
      readSettingsEnv(),
    ]);
    const env = { ...shellEnv, ...settingsEnv };
    cache = { at: Date.now(), env };
    inflight = null;
    return env;
  })();
  return inflight;
}

/**
 * 最终子进程 env：provider 环境打底，进程显式配置覆盖；
 * 空值键不覆盖有效值（进程里残留的空串容易误伤）。
 */
export async function mergeClaudeEnv(
  processEnv: EnvMap = process.env,
): Promise<NodeJS.ProcessEnv> {
  const provider = await loadClaudeProviderEnv();
  return applyProviderEnv(processEnv, provider);
}

/** 同步版：用已缓存的 provider 环境（调用前先 await loadClaudeProviderEnv 预热） */
export function mergeClaudeEnvSync(
  processEnv: EnvMap = process.env,
): NodeJS.ProcessEnv {
  return applyProviderEnv(processEnv, cache?.env ?? {});
}

/** 通用别名（codex 等其他适配器复用） */
export const mergeProviderEnvSync = mergeClaudeEnvSync;
export const loadProviderEnv = loadClaudeProviderEnv;

function applyProviderEnv(
  processEnv: EnvMap,
  provider: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...processEnv };
  for (const [key, value] of Object.entries(provider)) {
    const existing = merged[key];
    if (existing === undefined || existing === '') merged[key] = value;
  }
  return merged;
}

/** 测试用：清缓存 */
export function resetClaudeEnvCache() {
  cache = null;
  inflight = null;
}
