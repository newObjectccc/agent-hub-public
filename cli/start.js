#!/usr/bin/env node
// agent-hub start — 依赖检查 → vite build(web) → tsc(server) → 启动 server/dist/index.js。
// 发包布局（npm pack / npx）下跳过依赖检查与构建（依赖随 npm 安装、产物随包发布），直接启动。
// 纯 Node 跨平台；Ctrl+C 干净退出（杀子进程）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { parseCliArgs, startHelpText } from './lib/args.js';
import { defaultConfigPath, defaultConfigTemplatePath, repoRoot, isPublishedLayout } from './lib/paths.js';
import { versionAtLeast } from './lib/detect.js';
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

/** node_modules 完整性：root + server + web 三处都在才算依赖已装（仅源码仓布局用）。 */
export function depsInstalled(root, exists = fs.existsSync) {
  return ['node_modules', path.join('server', 'node_modules'), path.join('web', 'node_modules')]
    .every((p) => exists(path.join(root, p)));
}

/**
 * 发包布局判定（npm pack / npx 安装形态）：server/package.json 与 web/package.json 都不存在，
 * 且 server/dist/index.js 与 web/dist/index.html 产物都在 → true。
 * 此布局下依赖随 npm 安装（解析到包根 node_modules）、产物随包发布，install/build 两步必然无意义且必败。
 */
export { isPublishedLayout };

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
  const configPath = deps.configPath ?? defaultConfigPath(root, { home: deps.home });

  log(colors.bold('agent-hub start') + colors.dim(` (platform=${platform}${dryRun ? ', dry-run' : ''})`));
  if (!versionAtLeast(deps.nodeVersion ?? process.versions.node, '22.19.0')) {
    log(`${colors.fail} 需要 Node.js ≥ 22.19；请升级 Node 后重试。`);
    return 1;
  }

  // 1. 配置：缺失自愈（从模板生成）；--port / --lan 覆盖写入（server 读 config/hub.config.json）
  let config;
  try {
    const overrides = {};
    if (options.port !== undefined) overrides.port = assertPort(options.port);
    if (options.lan) {
      overrides.host = '0.0.0.0';
      // server isSafeBindHost 要求通配绑定必须显式 opt-in（防误配暴露公网）
      overrides.allowLan = true;
    }
    const missing = !fs.existsSync(configPath);
    if (missing || Object.keys(overrides).length) {
      const res = ensureConfig({
        configPath,
        templatePath: defaultConfigTemplatePath(root),
        overrides,
        dryRun,
      });
      log(missing
        ? `${colors.ok} 配置不存在，已自动生成: ${configPath} ${colors.dim('(完整初始化、装 pi 扩展请运行 agent-hub setup)')}`
        : `${colors.ok} 配置已${dryRun ? '（dry-run 将）' : ''}更新: ${configPath} ${colors.dim(`(port=${res.config.port}, host=${res.config.host})`)}`);
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

  // 2+3. 依赖安装与构建：仅源码仓布局需要。发包布局（npm pack / npx）依赖随 npm 安装、
  // 产物已随包发布，install/build 必然无意义且必败（无 server/web/package.json 与源码），直接跳过。
  const published = isPublishedLayout(root);
  if (published) {
    log(`${colors.info} 发包布局：依赖随 npm 安装、产物已随包发布，跳过依赖安装与构建`);
  } else {
    // 2. 依赖安装（node_modules 缺失时 pnpm install，pnpm 缺失回退 npm）
    const pm = resolvePackageManager({ platform, env });
    if (!pm.available) {
      log(`${colors.fail} 未找到 pnpm / npm。请先安装 Node.js ≥ 22.19（自带 npm）。`);
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
          // 降级：构建失败不阻塞启动（弱网 pnpm 超时 / 并发锁场景实测踩坑）——
          // 产物存在则用现有构建继续，仅无产物才退出（自启时宁可跑旧版也不躺平）
          const artifact = step.cwd.endsWith('web')
            ? path.join(step.cwd, 'dist', 'index.html')
            : path.join(step.cwd, 'dist', 'index.js');
          if (fs.existsSync(artifact)) {
            log(`${colors.warn} ${step.label} 失败（${res.error || res.stderr.trim() || '未知原因'}）`);
            log(`${colors.warn} 检测到已有构建产物，降级用现有构建继续启动（稍后可手动 npm run build 更新）`);
            continue;
          }
          log(`${colors.fail} ${step.label} 失败: ${res.error || res.stderr.trim() || res.stdout.trim()}`);
          return 1;
        }
        log(`${colors.ok} ${step.label} 完成`);
      }
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
    if (dryRun) {
      log(colors.dim(`  [dry-run] 将检查 Tailscale 并配置 Serve：${tailscaleServeCommand(port)}；本次不执行。`));
    } else {
      const ts = setupTailscaleServe(port, { platform, env });
      for (const line of ts.message.split('\n')) {
        log(ts.ok ? `${colors.ok} ${line}` : `${colors.warn} ${line}`);
      }
      if (ts.ok && ts.tsUrl) log(`  ${colors.bold(ts.tsUrl)}`);
      if (!ts.ran && ts.command) log(`  确切命令 / exact command: ${colors.bold(ts.command)}`);
    }
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
