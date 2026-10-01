// hub.config.json 读取、生成（模板复制）与合并（--port / --session-dir / --workspace-root 覆盖）。
// 模板为入库的 config/hub.config.example.json；真实 config/hub.config.json 不入库（本机路径/可选 token）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPort } from './process.js';
import { expandHome } from './paths.js';

export const CONFIG_KEYS = ['port', 'host', 'sessionDir', 'workspaceRoot', 'kpiRefreshMinutes', 'auth'];

/** 模板缺失时的内置默认（与 config/hub.config.example.json 一致）。 */
export const DEFAULT_CONFIG = {
  port: 7700,
  host: '127.0.0.1',
  sessionDir: '~/.pi/agent/sessions',
  workspaceRoot: '~/Workspace',
  kpiRefreshMinutes: 5,
  auth: { enabled: false, token: '' },
};

/**
 * 应用覆盖项（纯函数，便于测试）：
 * - port：校验 1-65535 整数
 * - sessionDir / workspaceRoot / host：非空字符串
 * - 未提供的键保持原值；未知字段原样保留（不整体覆盖已有配置）
 * @returns {object} 新 config 对象
 */
export function applyOverrides(config, overrides = {}) {
  const next = { ...config };
  if (overrides.port !== undefined && overrides.port !== null && overrides.port !== '') {
    next.port = assertPort(overrides.port);
  }
  for (const key of ['sessionDir', 'workspaceRoot', 'host']) {
    const v = overrides[key];
    if (v !== undefined && v !== null && v !== '') {
      if (typeof v !== 'string') throw new Error(`${key} 必须是字符串`);
      next[key] = v;
    }
  }
  return next;
}

/** 读取 config（JSON 解析失败抛错）。 */
export function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${configPath}\n${e.message}`);
  }
  return parsed;
}

/**
 * 确保 config 存在并应用覆盖：
 * - 不存在：从 config/hub.config.example.json 模板复制（模板缺失用内置默认）+ 应用覆盖后写入
 *   · 新建时探测 workspaceRoot 目录是否存在（如 Linux 常无 ~/Workspace），不存在则回落 home 目录（'~'）
 * - 已存在：读取并合并覆盖（保留未知字段），有覆盖项才回写（不动 workspaceRoot，幂等）
 * @returns {{created: boolean, wrote: boolean, path: string, config: object, workspaceRootFallback: boolean}}
 */
export function ensureConfig({
  configPath,
  templatePath,
  overrides = {},
  dryRun = false,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const hasOverrides = Object.values(overrides).some((v) => v !== undefined && v !== null && v !== '');
  let created = false;
  let base;

  if (fs.existsSync(configPath)) {
    base = loadConfig(configPath);
  } else {
    created = true;
    base = templatePath && fs.existsSync(templatePath) ? loadConfig(templatePath) : { ...DEFAULT_CONFIG };
  }

  const config = applyOverrides(base, overrides);

  // 新建时探测 workspaceRoot（显式 --workspace-root 不回落）：目录不存在 → 回落 home 目录
  const explicitWorkspaceRoot = overrides.workspaceRoot !== undefined
    && overrides.workspaceRoot !== null
    && overrides.workspaceRoot !== '';
  let workspaceRootFallback = false;
  if (created && !explicitWorkspaceRoot && typeof config.workspaceRoot === 'string' && config.workspaceRoot) {
    const resolved = expandHome(config.workspaceRoot, home);
    if (!exists(resolved)) {
      config.workspaceRoot = '~';
      workspaceRootFallback = true;
    }
  }

  const wrote = created || hasOverrides;
  if (wrote && !dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return { created, wrote, path: configPath, config, workspaceRootFallback };
}
