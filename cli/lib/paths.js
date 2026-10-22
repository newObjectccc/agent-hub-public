// 路径工具：`~` 展开、跨平台分隔符、仓库根定位。纯 Node，零依赖。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 展开路径中的 `~` / `~/...` / `~\...` 为用户主目录。
 * - `~user` 形式不展开（无法跨平台可靠解析），原样返回。
 * - 空值原样返回。其余路径原样返回（不做 resolve，语义保留给调用方）。
 * @param {string} p
 * @param {string} [home] 主目录注入（测试用）
 * @param {string} [sep] 路径分隔符（测试用，默认平台分隔符）
 */
export function expandHome(p, home = os.homedir(), sep = path.sep) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2);
    const parts = rest.split(/[\\/]/).filter((s) => s.length > 0);
    return [home, ...parts].join(sep);
  }
  return p;
}

/**
 * 把路径中的分隔符统一为平台分隔符（处理 Windows 混用 `/` `\` 的情况）。
 * 保留开头的 UNC 前缀 `\\` 与盘符。
 */
export function normalizeSeparators(p, sep = path.sep) {
  if (typeof p !== 'string' || p.length === 0) return p;
  return p.split(/[\\/]/).join(sep);
}

/**
 * 展开 `~` 后再与 base 做 path.resolve：
 * - `~/x` → <home>/x
 * - 相对路径 → 相对 base 解析
 * - 绝对路径原样 resolve
 */
export function resolvePath(p, { base = process.cwd(), home = os.homedir(), sep = path.sep } = {}) {
  const expanded = expandHome(p, home, sep);
  return path.resolve(base, expanded);
}

/** cli/ 目录（本文件所在目录的上一级） */
export function cliDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** 仓库根目录（cli/ 的上一级） */
export function repoRoot() {
  return path.dirname(cliDir());
}

/** 发包布局无需源码构建；npm 安装的依赖可能被提升到包目录之外。 */
export function isPublishedLayout(root, exists = fs.existsSync) {
  return !exists(path.join(root, 'server', 'package.json'))
    && !exists(path.join(root, 'web', 'package.json'))
    && exists(path.join(root, 'server', 'dist', 'index.js'))
    && exists(path.join(root, 'web', 'dist', 'index.html'));
}

/** npm/npx 的配置与状态独立于安装目录，升级或清缓存不会抹掉应用锁及用户配置。
 * 源码仓继续使用仓库内 config/data。
 */
export function runtimeDirs(root = repoRoot(), { home = os.homedir(), exists = fs.existsSync } = {}) {
  const base = isPublishedLayout(root, exists) ? path.join(home, '.agent-hub') : root;
  return { configDir: path.join(base, 'config'), dataDir: path.join(base, 'data') };
}

/** CLI 与 server 共用运行时目录规则。 */
export function defaultConfigPath(root = repoRoot(), options = {}) {
  return path.join(runtimeDirs(root, options).configDir, 'hub.config.json');
}

/**
 * 配置模板（示例）位置：config/hub.config.example.json（入库，供参考/生成）。
 * 真实 config/hub.config.json 不入库（含本机路径/可选 token），由 setup 从模板生成。
 */
export function defaultConfigTemplatePath(root = repoRoot()) {
  return path.join(root, 'config', 'hub.config.example.json');
}
