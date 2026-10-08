// 网络工具：局域网 IP 枚举、Tailscale Serve 引导。
import os from 'node:os';
import { runCapture, findCommand, isWindows } from './process.js';

/** 枚举本机局域网 IPv4 地址（排除 internal / IPv6）。 */
export function listLanIps(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const a of addrs ?? []) {
      if (a && a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out;
}

/** 生成 tailscale serve 命令（HTTPS，官方 Tailscale 自动签证书；的确切命令行，可直接复制执行）。 */
export function tailscaleServeCommand(port) {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}

/** tailnet 内 HTTP serve（自建 headscale 无自动证书时的回退方案）。 */
export function tailscaleServeHttpCommand(port, httpPort = 8080) {
  return `tailscale serve --bg --http=${httpPort} http://127.0.0.1:${port}`;
}

/** 解析 `tailscale debug prefs`（纯函数，供测试）：取出 ControlURL（空=官方）。 */
export function parseControlUrl(prefsJsonText) {
  try {
    const prefs = JSON.parse(String(prefsJsonText ?? ''));
    return typeof prefs?.ControlURL === 'string' ? prefs.ControlURL.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 是否官方 Tailscale 控制面（决定 serve 用 HTTPS 还是 HTTP）。
 * 官方控制面支持 `tailscale cert` 自动签发；headscale 等自建控制面不支持。
 */
export function isOfficialControlUrl(controlUrl) {
  if (!controlUrl) return true; // 未知时按官方处理（主流场景）
  return /(^|\.)tailscale\.com/i.test(new URL(controlUrl).hostname);
}

/** 解析 `tailscale status --json`（纯函数，供测试）。 */
export function parseTailscaleStatus(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText ?? ''));
  } catch {
    return { ok: false, loggedIn: false, running: false, dnsName: null, state: null };
  }
  const self = data?.Self ?? {};
  const dnsName = typeof self.DNSName === 'string' && self.DNSName.trim()
    ? self.DNSName.trim().replace(/\.$/, '')
    : null;
  const state = typeof data?.BackendState === 'string' ? data.BackendState : null;
  return {
    ok: true,
    loggedIn: Boolean(self) && state !== 'NeedsLogin',
    running: state === 'Running' || self.Online === true,
    dnsName,
    state,
  };
}

/**
 * Tailscale Serve 引导（双模式）：
 * - 官方 Tailscale 控制面 → `serve --https=443`（自动签证书，手机可装成真 WebAPK）
 * - 自建 headscale → `serve --http=8080`（headscale 不支持 tailscale cert，走 tailnet 内 HTTP）
 * 检测顺序：tailscale 可执行 → status 状态诊断 → 控制面识别 → 自动执行 serve，失败给出确切命令。
 * @returns {{ok, ran, command, tsUrl, mode: 'https'|'http'|null, message}}
 */
export function setupTailscaleServe(port, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    run = runCapture,
    find = findCommand,
  } = deps;
  const httpsCommand = tailscaleServeCommand(port);
  const httpCommand = tailscaleServeHttpCommand(port);

  // 1) tailscale 是否存在
  const locate = find('tailscale', { platform, env, run });
  if (!locate.found) {
    return {
      ok: false,
      ran: false,
      command: httpsCommand,
      tsUrl: null,
      mode: null,
      message: '未检测到 tailscale。可跳过（用 --lan 局域网模式），或安装后执行：\n  ' + httpsCommand,
    };
  }

  // 2) 状态诊断（CLI 损坏 / 未登录 / 已停止 各给可操作指引）
  const statusRes = run('tailscale', ['status', '--json'], { env, shell: isWindows(platform) });
  if (!statusRes.ok) {
    return {
      ok: false,
      ran: false,
      command: httpsCommand,
      tsUrl: null,
      mode: null,
      message: `无法获取 tailscale 状态（${statusRes.error || statusRes.stderr.trim() || '未知原因'}）。\n`
        + '若命令直接崩溃，多为 PATH 中的 tailscale 二进制损坏（如 macOS 出现 Trace/BPT trap）：\n'
        + '请重装官方客户端，或改用 App 内置 CLI（macOS: /Applications/Tailscale.app/Contents/MacOS/Tailscale）。',
    };
  }
  const status = parseTailscaleStatus(statusRes.stdout);
  if (!status.running) {
    const advice = status.state === 'NeedsLogin'
      ? 'tailscale 尚未登录。请打开 Tailscale App 登录（或执行 `tailscale up`）后重试。'
      : status.state === 'Stopped'
        ? 'tailscale 已停止。请打开 Tailscale App 连接（或执行 `tailscale up`）后重试。'
        : `tailscale 未就绪（状态: ${status.state || '未知'}）。请打开 Tailscale App 检查连接后重试。`;
    return {
      ok: false,
      ran: false,
      command: httpsCommand,
      tsUrl: null,
      mode: null,
      message: `${advice}\n连接后执行：\n  ${httpsCommand}`,
    };
  }

  // 3) 控制面识别：官方 → HTTPS 自动证书；自建 headscale → tailnet 内 HTTP
  const prefsRes = run('tailscale', ['debug', 'prefs'], { env, shell: isWindows(platform) });
  const official = isOfficialControlUrl(parseControlUrl(prefsRes.stdout));
  const mode = official ? 'https' : 'http';

  // 4) 自动执行 serve（失败不致命，打印确切命令）
  const serveArgs = official
    ? ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]
    : ['serve', '--bg', '--http=8080', `http://127.0.0.1:${port}`];
  const serveRes = run('tailscale', serveArgs, { env, shell: isWindows(platform), timeout: 20_000 });
  const command = official ? httpsCommand : httpCommand;
  const tsUrl = status.dnsName
    ? `${official ? 'https' : 'http'}://${status.dnsName}${official ? '' : ':8080'}`
    : null;

  if (serveRes.ok) {
    const pwaNote = official
      ? '手机浏览器打开该地址 → 菜单 →「安装应用」= 无地址栏真 PWA（WebAPK）。'
      : '说明：自建 headscale 不支持自动 HTTPS 证书，tailnet 内 HTTP 功能完整；\n'
        + '但浏览器视为非安全源，PWA 只能装成简化快捷方式。真 PWA 方案见 docs/HEADSCALE.md。';
    return {
      ok: true,
      ran: true,
      command,
      tsUrl,
      mode,
      message: `${official ? 'Tailscale Serve 已开启（HTTPS）' : 'Tailscale Serve 已开启（tailnet 内 HTTP）'}：${tsUrl || '(地址用 `tailscale status` 查看)'}\n${pwaNote}`,
    };
  }

  return {
    ok: false,
    ran: false,
    command,
    tsUrl,
    mode,
    message: `自动执行 tailscale serve 失败（${serveRes.error || serveRes.stderr.trim() || '未知原因'}）。\n请手动执行：\n  ${command}`
      + (/GUI failed to start|CLIError/i.test(`${serveRes.error} ${serveRes.stderr}`)
        ? '\nmacOS GUI 桥异常时改用 root 执行（直连守护进程，实测有效）：\n  sudo ' + command
        : ''),
  };
}
