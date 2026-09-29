// 路径工具：`~` 展开、跨平台分隔符、仓库根定位。纯 Node，零依赖。
import os from 'node:os';
import path from 'node:path';
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

/** 相对仓库根解析配置文件位置 */
export function defaultConfigPath(root = repoRoot()) {
  return path.join(root, 'config', 'hub.config.json');
}
