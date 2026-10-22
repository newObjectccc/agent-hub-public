#!/usr/bin/env node
// agent-hub dev — 一条命令开发调试：server tsc --watch + node --watch 热重启 + web Vite HMR。
// 配置缺失自动生成（从模板）；Ctrl+C 干净退出（一次杀全部子进程）。纯 Node 跨平台，零 bash 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { parseCliArgs, devHelpText } from './lib/args.js';
import { defaultConfigPath, defaultConfigTemplatePath, repoRoot } from './lib/paths.js';
import { ensureConfig, loadConfig } from './lib/config.js';
import {
  assertPort,
  installDeps,
  isWindows,
  resolvePackageManager,
  runPackageManagerScript,
  runSpawn,
} from './lib/process.js';
import { depsInstalled, stopChild } from './start.js';

/**
 * 行前缀流：把子进程输出按行切分并加 `[tag] ` 前缀（纯逻辑，可测）。
 * 跨 chunk 的半行先缓存，flush 时兜底吐出。
 * @param {string} tag
 * @param {(line: string) => void} write 已加前缀的整行回调（空行原样传 ''）
 */
export function createLineStream(tag, write) {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) write(line ? `[${tag}] ${line}` : '');
    },
    flush() {
      if (buf) write(`[${tag}] ${buf}`);
      buf = '';
    },
  };
}

export async function main(argv = [], deps = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, {
      booleans: ['help', 'color'],
      values: ['port', 'web-port'],
    });
  } catch (e) {
    console.error(e.message);
    console.error(devHelpText());
    return 1;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(devHelpText());
    return 0;
  }

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const colors = createColors({ enabled: options.color !== false && deps.useColor !== false });
  const root = deps.root ?? repoRoot();
  const configPath = deps.configPath ?? defaultConfigPath(root, { home: deps.home });

  log(colors.bold('agent-hub dev') + colors.dim(` (platform=${platform})`));

  // 1. 配置自愈：缺失时从模板生成默认配置（可后续 agent-hub setup 完整初始化）
  let config;
  try {
    const overrides = {};
    if (options.port !== undefined) overrides.port = assertPort(options.port);
    const missing = !fs.existsSync(configPath);
    if (missing || Object.keys(overrides).length) {
      const res = ensureConfig({
        configPath,
        templatePath: defaultConfigTemplatePath(root),
        overrides,
      });
      log(missing
        ? `${colors.ok} 配置不存在，已自动生成: ${configPath} ${colors.dim('(可按需编辑；完整初始化请运行 agent-hub setup)')}`
        : `${colors.ok} 配置已更新: ${configPath} ${colors.dim(`(port=${res.config.port})`)}`);
      config = res.config;
    } else {
      config = loadConfig(configPath);
    }
    assertPort(config.port);
  } catch (e) {
    log(`${colors.fail} 配置无效: ${e.message}`);
    return 1;
  }

  const port = assertPort(config.port);
  const webPort = options.webPort !== undefined ? assertPort(options.webPort) : 5173;

  // 2. 依赖：node_modules 缺失时安装（pnpm 优先，缺失回退 npm）
  const pm = resolvePackageManager({ platform, env });
  if (!pm.available) {
    log(`${colors.fail} 未找到 pnpm / npm。请先安装 Node.js ≥ 22.19（自带 npm）。`);
    return 1;
  }
  if (!depsInstalled(root)) {
    log(`${colors.info} 检测到 node_modules 缺失，使用 ${pm.name} install 安装依赖…`);
    const res = installDeps(pm, { cwd: root, env, platform });
    if (!res.ok) {
      log(`${colors.fail} ${pm.name} install 失败: ${res.error || res.stderr.trim()}`);
      return 1;
    }
    log(`${colors.ok} 依赖安装完成`);
  }

  // 3. server 初始构建（确保 dist 存在；之后交给 tsc --watch 增量）
  const serverDir = path.join(root, 'server');
  const webDir = path.join(root, 'web');
  log(`${colors.info} server 初始构建（tsc）…`);
  const build = runPackageManagerScript(pm, 'build', { cwd: serverDir, env, platform });
  if (!build.ok) {
    log(`${colors.fail} server 构建失败: ${build.error || build.stderr.trim() || build.stdout.trim()}`);
    return 1;
  }
  log(`${colors.ok} server 构建完成`);

  // 4. 三个子进程并行：tsc --watch（增量编译）/ node --watch（改代码自动重启）/ Vite（HMR）
  const serverUrl = `http://127.0.0.1:${port}`;
  const pipe = { stdio: ['ignore', 'pipe', 'pipe'] };
  const procs = [
    {
      tag: 'server:tsc',
      child: runSpawn(pm.name, ['run', 'dev'], { cwd: serverDir, env, ...pipe, shell: isWindows(platform) }),
    },
    {
      tag: 'server',
      child: runSpawn(process.execPath, ['--watch', path.join('dist', 'index.js')], { cwd: serverDir, env, ...pipe }),
    },
    {
      tag: 'web',
      child: runSpawn(pm.name, ['run', 'dev'], {
        cwd: webDir,
        env: { ...env, AGENT_HUB_SERVER: serverUrl, AGENT_HUB_WEB_PORT: String(webPort) },
        ...pipe,
        shell: isWindows(platform),
      }),
    },
  ];

  let stopping = false;
  let stopCode = 130;
  let alive = procs.length;
  const stopAll = (signal) => {
    if (stopping) return;
    stopping = true;
    stopCode = signal === 'SIGINT' ? 130 : 143;
    log('');
    log(`${colors.info} 收到 ${signal}，正在停止开发进程…`);
    for (const { child } of procs) stopChild(child);
    // 兜底：5s 后强制退出（子进程全部退出时会更早收尾）
    setTimeout(() => process.exit(stopCode), 5_000);
  };
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));

  for (const { tag, child } of procs) {
    const stream = createLineStream(tag, (line) => log(line ? colors.dim(line) : ''));
    child.stdout?.on('data', (c) => stream.push(c));
    child.stderr?.on('data', (c) => stream.push(c));
    child.on('error', (e) => {
      log(`${colors.fail} [${tag}] 启动失败: ${e.message}`);
      stopAll('SIGTERM');
    });
    child.on('exit', (code, signal) => {
      stream.flush();
      alive -= 1;
      if (stopping) {
        if (alive <= 0) process.exit(stopCode);
        return;
      }
      log(`${colors.warn} [${tag}] 进程退出 (code=${code ?? signal})`);
      if (alive <= 0) {
        log(`${colors.info} 全部开发进程已退出`);
        process.exit(0);
      }
    });
  }

  log('');
  log(`${colors.info} 开发模式就绪 / dev ready`);
  log(`  ${colors.bold(`web: http://localhost:${webPort}`)} ${colors.dim('（Vite HMR，前端调试入口；/api /ws 已代理到 server）')}`);
  log(`  ${colors.bold(`api: ${serverUrl}`)} ${colors.dim('（server 热重载：tsc --watch + node --watch）')}`);
  log(`  ${colors.dim('Ctrl+C 一次停止全部进程')}`);
  log('');

  // 前台常驻，直到信号触发退出
  await new Promise(() => {});
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = isDirectRunCheck(import.meta.url);
if (isDirectRun) {
  // 管道被提前关闭（如 | head）时静默退出，不抛 EPIPE
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`dev 失败: ${e.message}`);
      process.exit(1);
    });
}
