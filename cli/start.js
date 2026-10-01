#!/usr/bin/env node
// agent-hub start — 依赖检查 → vite build(web) → tsc(server) → 启动 server/dist/index.js。
// 纯 Node 跨平台；Ctrl+C 干净退出（杀子进程）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { parseCliArgs, startHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot } from './lib/paths.js';
import { ensureConfig, loadConfig } from './lib/config.js';
import {
  assertPort,
  installDeps,
  isWindows,
  resolvePackageManager,
  runCapture,
  runPackageManagerScript,
  runSpawn,
} from './lib/process.js';
import { listLanIps, setupTailscaleServe, tailscaleServeCommand } from './lib/net.js';

/** node_modules 完整性：root + server + web 三处都在才算依赖已装。 */
export function depsInstalled(root, exists = fs.existsSync) {
  return ['node_modules', path.join('server', 'node_modules'), path.join('web', 'node_modules')]
    .every((p) => exists(path.join(root, p)));
}

/** 面板 URL（host=0.0.0.0 时回退 127.0.0.1 展示本机入口）。 */
export function panelUrl(config) {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

/** 杀子进程（含 Windows 进程树），幂等。 */
export function stopChild(child, run = runCapture) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows()) {
    run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000 });
    return;
  }
  try { child.kill('SIGINT'); } catch { /* 已退出 */ }
  setTimeout(() => {
    try { if (child.exitCode === null) child.kill('SIGTERM'); } catch { /* ignore */ }
  }, 2_000).unref?.();
  setTimeout(() => {
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 5_000).unref?.();
}

export async function main(argv = [], deps = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, {
      booleans: ['lan', 'tailscale', 'skip-build', 'dry-run', 'help', 'color'],
      values: ['port'],
    });
  } catch (e) {
    console.error(e.message);
    console.error(startHelpText());
    return 1;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(startHelpText());
    return 0;
  }

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const colors = createColors({ enabled: options.color !== false && deps.useColor !== false });
  const root = deps.root ?? repoRoot();
  const dryRun = Boolean(options.dryRun);
  const configPath = deps.configPath ?? defaultConfigPath(root);

  log(colors.bold('agent-hub start') + colors.dim(` (platform=${platform}${dryRun ? ', dry-run' : ''})`));

  // 1. 配置：--port / --lan 覆盖写入（server 读 config/hub.config.json）
  if (!fs.existsSync(configPath)) {
    log(`${colors.fail} 配置不存在: ${configPath}`);
    log(`  请先运行 ${colors.bold('agent-hub setup')}（源码运行：node cli/setup.js）生成配置。`);
    return 1;
  }
  let config;
  try {
    let overrides = {};
    if (options.port !== undefined) overrides.port = assertPort(options.port);
    if (options.lan) overrides.host = '0.0.0.0';
    if (Object.keys(overrides).length) {
      const res = ensureConfig({ configPath, templatePath: configPath, overrides, dryRun });
      log(`${colors.ok} 配置已${dryRun ? '（dry-run 将）' : ''}更新: ${configPath} ${colors.dim(`(port=${res.config.port}, host=${res.config.host})`)}`);
      config = res.config;
    } else {
      config = loadConfig(configPath);
    }
    assertPort(config.port);
  } catch (e) {
    log(`${colors.fail} 配置无效: ${e.message}`);
    return 1;
  }

  const port = config.port;
  log(`${colors.info} 面板地址: ${colors.bold(panelUrl(config))}`);

  // 2. 依赖安装（node_modules 缺失时 pnpm install，pnpm 缺失回退 npm）
  const pm = resolvePackageManager({ platform, env });
  if (!pm.available) {
    log(`${colors.fail} 未找到 pnpm / npm。请先安装 Node.js ≥ 20（自带 npm）。`);
    return 1;
  }
  if (!depsInstalled(root)) {
    log(`${colors.info} 检测到 node_modules 缺失，使用 ${pm.name} install 安装依赖…`);
    if (dryRun) {
      log(colors.dim(`  [dry-run] 将执行: ${pm.name} install`));
    } else {
      const res = installDeps(pm, { cwd: root, env, platform });
      if (!res.ok) {
        log(`${colors.fail} ${pm.name} install 失败: ${res.error || res.stderr.trim()}`);
        return 1;
      }
      log(`${colors.ok} 依赖安装完成`);
    }
  } else {
    log(`${colors.ok} 依赖已就绪`);
  }

  // 3. 构建：web（vite build）→ server（tsc），均经包管理器 run build（跨平台无 shell 依赖问题）
  const buildSteps = [
    { label: 'web 构建（vite build）', cwd: path.join(root, 'web') },
    { label: 'server 构建（tsc）', cwd: path.join(root, 'server') },
  ];
  if (options.skipBuild) {
    log(`${colors.info} --skip-build：跳过构建`);
  } else {
    for (const step of buildSteps) {
      log(`${colors.info} ${step.label}…`);
      if (dryRun) {
        log(colors.dim(`  [dry-run] 将执行: ${pm.name} run build (cwd=${step.cwd})`));
        continue;
      }
      const res = runPackageManagerScript(pm, 'build', { cwd: step.cwd, env, platform });
      if (!res.ok) {
        log(`${colors.fail} ${step.label} 失败: ${res.error || res.stderr.trim() || res.stdout.trim()}`);
        return 1;
      }
      log(`${colors.ok} ${step.label} 完成`);
    }
  }

  // 4. --lan：打印本机局域网 IP
  if (options.lan) {
    log('');
    log(colors.bold('== 局域网模式 / LAN mode =='));
    log(`${colors.info} host ${dryRun ? '将' : '已'}写为 0.0.0.0（仅建议在可信局域网使用，勿直接暴露公网）`);
    const ips = listLanIps();
    if (ips.length) {
      for (const { name, address } of ips) {
        log(`  ${colors.bold(`http://${address}:${port}`)} ${colors.dim(`(${name})`)}`);
      }
    } else {
      log(colors.dim('  未发现局域网 IPv4 地址，请用 ipconfig / ifconfig 确认'));
    }
  }

  // 5. --tailscale：检测 + 自动/引导 tailscale serve + ts.net 地址
  if (options.tailscale) {
    log('');
    log(colors.bold('== Tailscale 远程访问 / Tailscale remote =='));
    const ts = setupTailscaleServe(port, { platform, env });
    for (const line of ts.message.split('\n')) {
      log(ts.ok ? `${colors.ok} ${line}` : `${colors.warn} ${line}`);
    }
    if (ts.tsUrl) log(`  ${colors.bold(ts.tsUrl)}`);
    if (!ts.ran && ts.command) log(`  确切命令 / exact command: ${colors.bold(ts.command)}`);
  }

  // 6. 启动 server（node server/dist/index.js，继承 stdio）
  const serverEntry = path.join(root, 'server', 'dist', 'index.js');
  if (!fs.existsSync(serverEntry) && !dryRun) {
    log(`${colors.fail} 构建产物不存在: ${serverEntry}`);
    log('  请确认 server 构建成功（去掉 --skip-build 重试，或手动 npm run build --prefix server）。');
    return 1;
  }
  log('');
  log(`${colors.info} 启动 server: node ${serverEntry}`);
  if (dryRun) {
    if (!fs.existsSync(serverEntry)) log(colors.dim(`  [dry-run] 注意: ${serverEntry} 当前不存在，真实运行前需构建成功`));
    log(colors.dim('  [dry-run] 不实际启动。命令行等价于: node server/dist/index.js'));
    log(`${colors.ok} dry-run 完成`);
    return 0;
  }

  const child = runSpawn(process.execPath, [serverEntry], { cwd: root, env, stdio: 'inherit' });

  // Ctrl+C / SIGTERM 干净退出：杀子进程，兜底强制退出
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    log('');
    log(`${colors.info} 收到 ${signal}，正在停止 server…`);
    stopChild(child);
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 5_000);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => {
      log(`${colors.fail} server 启动失败: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 0 : (code ?? 0)));
  });
  log(`${colors.info} server 已退出 (code=${exitCode})`);
  return exitCode;
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = isDirectRunCheck(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`start 失败: ${e.message}`);
      process.exit(1);
    });
}
