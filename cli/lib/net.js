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

/** 生成 tailscale serve 命令（的确切命令行，可直接复制执行）。 */
export function tailscaleServeCommand(port) {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}

/** 解析 `tailscale status --json`（纯函数，供测试）。 */
export function parseTailscaleStatus(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText ?? ''));
  } catch {
    return { ok: false, loggedIn: false, running: false, dnsName: null };
  }
  const self = data?.Self ?? {};
  const dnsName = typeof self.DNSName === 'string' && self.DNSName.trim()
    ? self.DNSName.trim().replace(/\.$/, '')
    : null;
  return {
    ok: true,
    loggedIn: Boolean(self),
    running: Boolean(data?.BackendState === 'Running' || self.Online === true),
    dnsName,
  };
}

/**
 * Tailscale Serve 引导：
 * - 检测 tailscale 与 serve 能力
 * - 能自动执行则执行 `tailscale serve --bg --https=443 http://127.0.0.1:<port>`
 * - 否则返回确切命令由用户执行（复杂可跳过）
 * @returns {{ok, ran, command, tsUrl, message}}
 */
export function setupTailscaleServe(port, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    run = runCapture,
    find = findCommand,
  } = deps;
  const command = tailscaleServeCommand(port);

  // 1) tailscale 是否存在
  const locate = find('tailscale', { platform, env, run });
  if (!locate.found) {
    return {
      ok: false,
      ran: false,
      command,
      tsUrl: null,
      message: '未检测到 tailscale。可跳过（用 --lan 局域网模式），或安装后执行：\n  ' + command,
    };
  }

  // 2) 是否已登录 / 运行
  const statusRes = run('tailscale', ['status', '--json'], { env, shell: isWindows(platform) });
  const status = parseTailscaleStatus(statusRes.stdout);
  if (!statusRes.ok || !status.running) {
    return {
      ok: false,
      ran: false,
      command,
      tsUrl: null,
      message: 'tailscale 未运行或未登录。请先执行 `tailscale up` 登录，再运行：\n  ' + command,
    };
  }

  // 3) 尝试自动执行 serve（失败不致命，打印确切命令）
  const serveRes = run('tailscale', ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], {
    env,
    shell: isWindows(platform),
    timeout: 20_000,
  });
  const tsUrl = status.dnsName ? `https://${status.dnsName}` : null;
  if (serveRes.ok) {
    return {
      ok: true,
      ran: true,
      command,
      tsUrl,
      message: tsUrl
        ? `Tailscale Serve 已开启：${tsUrl}`
        : 'Tailscale Serve 已开启（ts.net 地址请用 `tailscale status` 查看）',
    };
  }
  return {
    ok: false,
    ran: false,
    command,
    tsUrl,
    message: `自动执行 tailscale serve 失败（${serveRes.error || serveRes.stderr.trim() || '未知原因'}）。\n请手动执行：\n  ${command}`,
  };
}
