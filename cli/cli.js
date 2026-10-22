#!/usr/bin/env node
// agent-hub — 子命令分发入口：setup | dev | start | remote | check | doctor | open
// 纯 Node 跨平台（Windows CMD / PowerShell 原生可用），零 bash 依赖。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { parseCliArgs, rootHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot } from './lib/paths.js';
import { isWindows, runCapture } from './lib/process.js';

const COMMANDS = ['setup', 'dev', 'start', 'remote', 'check', 'doctor', 'open'];

/** 读取 cli/package.json 版本号。 */
function cliVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * open：用平台命令打开面板 URL。
 * darwin: open / linux: xdg-open / win32: powershell Start-Process
 */
export async function openPanel(argv = [], deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const colors = createColors({ enabled: deps.useColor !== false });
  const root = deps.root ?? repoRoot();

  const { options, positionals } = parseCliArgs(argv, {
    booleans: ['help', 'color'],
    values: ['url'],
  });
  if (options.help) {
    console.log(`agent-hub open — 在浏览器打开面板 / open the panel in browser

用法 / Usage:
  node cli/cli.js open [url] [--url <url>]

未给 URL 时读取当前用户（npm）或源码仓配置，拼出面板地址。
平台命令：macOS= open，Linux= xdg-open，Windows= powershell Start-Process。`);
    return 0;
  }

  let url = options.url ?? positionals[0];
  if (!url) {
    const configPath = deps.configPath ?? defaultConfigPath(root, { home: deps.home });
    if (!fs.existsSync(configPath)) {
      log(`${colors.fail} 配置不存在: ${configPath}，请先运行 agent-hub setup（源码运行：node cli/setup.js），或显式传入 URL。`);
      return 1;
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
      url = `http://${host}:${cfg.port}`;
    } catch (e) {
      log(`${colors.fail} 配置解析失败: ${e.message}`);
      return 1;
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    log(`${colors.fail} 非法 URL: ${url}（需以 http:// 或 https:// 开头）`);
    return 1;
  }

  let res;
  if (platform === 'darwin') {
    res = runCapture('open', [url], { env });
  } else if (platform === 'linux') {
    res = runCapture('xdg-open', [url], { env });
  } else if (isWindows(platform)) {
    // Start-Process 走 powershell（start 是 cmd 内建，拼接有转义风险）
    const escaped = url.replace(/'/g, "''");
    res = runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${escaped}'`], { env });
  } else {
    log(`${colors.fail} 不支持的平台 ${platform}，请手动打开: ${url}`);
    return 1;
  }

  if (res.ok) {
    log(`${colors.ok} 已打开: ${colors.bold(url)}`);
    return 0;
  }
  log(`${colors.fail} 打开失败（${res.error || res.stderr.trim() || '未知原因'}），请手动访问: ${url}`);
  return 1;
}

/** 子命令分发。 */
export async function main(argv = process.argv.slice(2)) {
  const first = argv[0];

  if (!first || first === '-h' || first === '--help' || first === 'help') {
    console.log(rootHelpText());
    return first ? 0 : 1;
  }
  if (first === '-V' || first === '--version' || first === 'version') {
    console.log(`agent-hub v${cliVersion()}`);
    return 0;
  }
  if (!COMMANDS.includes(first)) {
    console.error(`未知命令: ${first}\n`);
    console.error(rootHelpText());
    return 1;
  }

  const rest = argv.slice(1);
  if (first === 'setup') {
    const { main: setupMain } = await import('./setup.js');
    return setupMain(rest);
  }
  if (first === 'dev') {
    const { main: devMain } = await import('./dev.js');
    return devMain(rest);
  }
  if (first === 'start') {
    const { main: startMain } = await import('./start.js');
    return startMain(rest);
  }
  if (first === 'remote') {
    const { main: remoteMain } = await import('./remote.js');
    return remoteMain(rest);
  }
  if (first === 'check' || first === 'doctor') {
    const { main: checkMain } = await import('./check.js');
    return checkMain(rest);
  }
  return openPanel(rest);
}

// 直接执行入口
const isDirectRun = isDirectRunCheck(import.meta.url);
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`agent-hub 失败: ${e.message}`);
      process.exit(1);
    });
}
