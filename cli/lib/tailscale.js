// Tailscale 是可选的系统客户端；这里只复用已安装的 CLI，不下载或安装 VPN 服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCommand, runCapture, isWindows } from './process.js';

/** PATH 优先，兼容未注册 CLI 的 macOS App / Windows 默认安装目录。 */
export function findTailscale(deps = {}) {
  const {
    platform = process.platform, env = process.env, run = runCapture,
    find = findCommand, exists = fs.existsSync, home = os.homedir(),
  } = deps;
  const located = find('tailscale', { platform, env, run, exists });
  if (located.found) return located;
  const candidates = platform === 'darwin'
    ? [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      path.join(home, 'Applications/Tailscale.app/Contents/MacOS/Tailscale'),
    ]
    : platform === 'win32'
      ? [path.win32.join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : [];
  const binary = candidates.find(candidate => exists(candidate));
  return binary ? { found: true, path: binary } : { found: false, path: null };
}

/** macOS App 的二进制也承担 GUI 入口；后台脚本需显式要求 CLI 模式。 */
export function tailscaleRunOptions({ platform = process.platform, env = process.env, binary = 'tailscale' } = {}) {
  return {
    env: platform === 'darwin' ? { ...env, TAILSCALE_BE_CLI: '1' } : env,
    shell: isWindows(platform) && !/\.exe$/i.test(binary),
  };
}

/** 供失败时复制执行：Windows 为 PowerShell，POSIX 路径使用单引号转义。 */
export function tailscaleCommandPrefix(binary, platform = process.platform) {
  if (binary === 'tailscale') return binary;
  if (isWindows(platform)) return `& '${binary.replace(/'/g, "''")}'`;
  const quoted = `'${binary.replace(/'/g, "'\\''")}'`;
  return platform === 'darwin' ? `env TAILSCALE_BE_CLI=1 ${quoted}` : quoted;
}

export function tailscaleInstallGuide(platform = process.platform) {
  const page = { darwin: 'mac', linux: 'linux', win32: 'windows' }[platform];
  const url = page ? `https://tailscale.com/docs/install/${page}` : 'https://tailscale.com/download';
  return `官方安装说明：${url}\n电脑与手机安装官方客户端，登录同一账号并连接；系统安装与登录由本人完成。`;
}
