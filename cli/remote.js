#!/usr/bin/env node
// agent-hub remote — 首次自动 setup → 启动；默认推荐 Tailscale，可选 --lan / --no-tailscale。
// 幂等：已初始化时直接走 start 流程；纯 Node 跨平台，零 bash 依赖。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { parseCliArgs, remoteHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot } from './lib/paths.js';
import { depsInstalled, isPublishedLayout } from './start.js';

/** 计划原因 → 展示文案。 */
export const PLAN_REASON_LABELS = {
  'missing-config': '缺少 config/hub.config.json',
  'missing-deps': '缺少 node_modules 依赖',
  'skip-setup': '--skip-setup',
  ready: '已初始化（config 与依赖就绪）',
};

/**
 * 远程启动计划（纯函数，供测试）：是否需要先跑 setup 及原因。
 * 幂等语义：已初始化（config 与依赖都在）→ 不再跑 setup。
 * @returns {{runSetup: boolean, reason: 'missing-config'|'missing-deps'|'skip-setup'|'ready'}}
 */
export function remotePlan({ hasConfig, hasDeps, skipSetup = false } = {}) {
  if (skipSetup) return { runSetup: false, reason: 'skip-setup' };
  if (!hasConfig) return { runSetup: true, reason: 'missing-config' };
  if (!hasDeps) return { runSetup: true, reason: 'missing-deps' };
  return { runSetup: false, reason: 'ready' };
}

/**
 * 生成透传给 setup / start 子流程的参数（纯函数，供测试）。
 * 默认推荐 Tailscale；--lan / --no-tailscale 跳过 Tailscale 配置。
 */
export function remoteChildArgs({ port, skipBuild = false, dryRun = false, color = true, lan = false, tailscale = true } = {}) {
  const common = [];
  if (port !== undefined && port !== null && port !== '') common.push('--port', String(port));
  if (dryRun) common.push('--dry-run');
  if (color === false) common.push('--no-color');
  return {
    setupArgs: [...common],
    startArgs: [...(lan ? ['--lan'] : tailscale ? ['--tailscale'] : []), ...common, ...(skipBuild ? ['--skip-build'] : [])],
  };
}

export async function main(argv = [], deps = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, {
      booleans: ['skip-setup', 'skip-build', 'dry-run', 'help', 'color', 'lan', 'tailscale'],
      values: ['port'],
    });
  } catch (e) {
    console.error(e.message);
    console.error(remoteHelpText());
    return 1;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(remoteHelpText());
    return 0;
  }

  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? console.log;
  const colorOn = options.color !== false && deps.useColor !== false;
  const colors = createColors({ enabled: colorOn });
  const root = deps.root ?? repoRoot();
  const dryRun = Boolean(options.dryRun);
  const configPath = deps.configPath ?? defaultConfigPath(root, { home: deps.home });
  if (options.lan && options.tailscale === true) {
    log('请选择 --lan 或 --tailscale，不能同时使用。');
    return 1;
  }

  log(colors.bold('agent-hub remote') + colors.dim(` (platform=${platform}${dryRun ? ', dry-run' : ''})`));

  const { setupArgs, startArgs } = remoteChildArgs({
    port: options.port,
    skipBuild: options.skipBuild === true,
    dryRun,
    color: colorOn,
    lan: options.lan === true,
    tailscale: options.tailscale !== false,
  });

  // [1/2] 初始化检查：缺 config / 依赖 → 首次自动 setup（幂等，已初始化则跳过）
  const plan = remotePlan({
    hasConfig: fs.existsSync(configPath),
    hasDeps: isPublishedLayout(root) || depsInstalled(root),
    skipSetup: options.skipSetup === true,
  });
  if (plan.runSetup) {
    log(`${colors.info} [1/2] 首次初始化（${PLAN_REASON_LABELS[plan.reason]}），执行 setup…`);
    const { main: setupMain } = await import('./setup.js');
    const code = await setupMain(setupArgs, deps);
    if (code !== 0) {
      // setup 非 0 仅表示核心依赖缺失（如 pi 未装）等提示性问题，start 流程自会复查；
      // 这里不中止，尽量保住一键体验，但明确告警。
      log(`${colors.warn} setup 未完全成功（exit=${code}），继续尝试启动；可按上方提示修复后重跑`);
    }
  } else {
    log(`${colors.ok} [1/2] ${PLAN_REASON_LABELS[plan.reason]}，跳过 setup`);
  }

  const mode = options.lan ? '局域网' : options.tailscale === false ? '沿用绑定配置，跳过 Tailscale' : 'Tailscale 远程（推荐，可选）';
  log(`${colors.info} [2/2] 准备并启动（${mode}）…`);
  const { main: startMain } = await import('./start.js');
  return startMain(startArgs, deps);
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = isDirectRunCheck(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`remote 失败: ${e.message}`);
      process.exit(1);
    });
}
