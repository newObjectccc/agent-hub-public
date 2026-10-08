// 服务自启注册（--autostart）：macOS launchd / Linux systemd --user / Windows schtasks。
// 全部失败仅提示，不崩溃；--dry-run 只打印将写入的内容与命令，不落盘、不注册。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCapture, isWindows } from './process.js';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * 服务进程的 PATH（纯函数，供测试）：launchd/systemd 的默认 PATH 不含 nvm/homebrew，
 * 会导致 start.js 构建步骤找不到 npm/pnpm（实测踩坑）——把 node 同目录与常见包管理器目录前置。
 */
export function buildServicePath(nodePath, base = '/usr/bin:/bin:/usr/sbin:/sbin') {
  const nodeDir = path.dirname(String(nodePath));
  return [nodeDir, '/usr/local/bin', '/opt/homebrew/bin', base].join(':');
}

/** 生成 macOS LaunchAgent plist（纯函数，供测试）。 */
export function buildLaunchdPlist({ label = 'com.agent-hub', nodePath, scriptPath, repoRoot, extraArgs = [], logDir, envPath }) {
  const args = [nodePath, scriptPath, ...extraArgs].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const servicePath = envPath ?? buildServicePath(nodePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(servicePath)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'agent-hub.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'agent-hub.err.log'))}</string>
</dict>
</plist>
`;
}

/** 生成 systemd user unit（纯函数，供测试）。 */
export function buildSystemdUnit({ nodePath, scriptPath, repoRoot, extraArgs = [], envPath }) {
  const exec = [nodePath, scriptPath, ...extraArgs].join(' ');
  const servicePath = envPath ?? buildServicePath(nodePath);
  return `[Unit]
Description=Agent Hub (pi agent session hub)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
Environment=PATH=${servicePath}
ExecStart=${exec}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** 生成 Windows schtasks 命令（纯函数，供测试）。 */
export function buildSchtasksCommand({ nodePath, scriptPath, extraArgs = [] }) {
  // /TR 传给 cmd 执行：node 与脚本路径均加引号（内层引号转义为 \"）
  const inner = `\\"${nodePath}\\" \\"${scriptPath}\\"${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}`;
  return [
    'schtasks', '/Create', '/TN', 'agent-hub',
    '/TR', inner,
    '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
  ];
}

/**
 * 注册自启。
 * @returns {{ok: boolean, method: string, detail: string, file?: string, commands: string[]}}
 */
export function installAutostart({
  platform = process.platform,
  home = os.homedir(),
  nodePath = process.execPath,
  repoRoot,
  extraArgs = [],
  dryRun = false,
  run = runCapture,
}) {
  const scriptPath = path.join(repoRoot, 'cli', 'start.js');

  try {
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      const file = path.join(dir, 'com.agent-hub.plist');
      const content = buildLaunchdPlist({
        nodePath, scriptPath, repoRoot, extraArgs,
        logDir: path.join(home, 'Library', 'Logs'),
      });
      const loadCmd = `launchctl load ${file}`;
      if (dryRun) {
        return { ok: true, method: 'launchd', detail: `[dry-run] 将写入 ${file}：\n${content}`, file, commands: [loadCmd] };
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      const load = run('launchctl', ['load', file], { timeout: 15_000 });
      return {
        ok: true,
        method: 'launchd',
        detail: `已写入 ${file}${load.ok ? '并 launchctl load' : `（launchctl load 失败：${load.error || load.stderr.trim()}，可稍后手动执行 ${loadCmd}）`}`,
        file,
        commands: [loadCmd],
      };
    }

    if (platform === 'linux') {
      const dir = path.join(home, '.config', 'systemd', 'user');
      const file = path.join(dir, 'agent-hub.service');
      const content = buildSystemdUnit({ nodePath, scriptPath, repoRoot, extraArgs });
      const enableCmds = ['systemctl --user daemon-reload', 'systemctl --user enable --now agent-hub.service'];
      if (dryRun) {
        return { ok: true, method: 'systemd-user', detail: `[dry-run] 将写入 ${file}：\n${content}`, file, commands: enableCmds };
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      const reload = run('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
      const enable = run('systemctl', ['--user', 'enable', '--now', 'agent-hub.service'], { timeout: 20_000 });
      return {
        ok: true,
        method: 'systemd-user',
        detail: `已写入 ${file}；${reload.ok ? 'daemon-reload 完成' : 'daemon-reload 失败'}，${enable.ok ? '已 enable --now' : `enable 失败（${enable.error || enable.stderr.trim()}），可手动：${enableCmds.join(' && ')}`}`,
        file,
        commands: enableCmds,
      };
    }

    if (isWindows(platform)) {
      const args = buildSchtasksCommand({ nodePath, scriptPath, extraArgs });
      const cmdLine = args.join(' ');
      if (dryRun) {
        return { ok: true, method: 'schtasks', detail: `[dry-run] 将执行：${cmdLine}`, commands: [cmdLine] };
      }
      const res = run(args[0], args.slice(1), { timeout: 20_000 });
      return {
        ok: res.ok,
        method: 'schtasks',
        detail: res.ok
          ? '已注册任务计划 agent-hub（登录时启动）'
          : `schtasks 注册失败（${res.error || res.stderr.trim()}），可手动执行：${cmdLine}`,
        commands: [cmdLine],
      };
    }

    return {
      ok: false,
      method: 'unsupported',
      detail: `暂不支持的平台 ${platform} 的自启注册，请手动配置`,
      commands: [],
    };
  } catch (e) {
    return { ok: false, method: 'error', detail: `自启注册失败（仅提示，不影响使用）：${e.message}`, commands: [] };
  }
}
