#!/usr/bin/env node
// agent-hub setup — 环境检测、生成 config、--autostart 平台适配、汇总报告。
// pi 缺失只提示安装方式（不自动全局安装）；tmux/ttyd/tailscale 缺失=建议，不算错误。
import { pathToFileURL } from 'node:url';
import { createColors } from './lib/color.js';
import { detectAll, installAdvice } from './lib/detect.js';
import { parseCliArgs, setupHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot } from './lib/paths.js';
import { ensureConfig } from './lib/config.js';
import { installAutostart } from './lib/autostart.js';
import { isWindows } from './lib/process.js';
import { printReport } from './check.js';

export async function main(argv = [], deps = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, {
      booleans: ['autostart', 'dry-run', 'help', 'color'],
      values: ['port', 'session-dir', 'workspace-root'],
    });
  } catch (e) {
    console.error(e.message);
    console.error(setupHelpText());
    return 1;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(setupHelpText());
    return 0;
  }

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const colors = createColors({ enabled: options.color !== false && deps.useColor !== false });
  const root = deps.root ?? repoRoot();
  const dryRun = Boolean(options.dryRun);

  log(colors.bold('agent-hub setup') + colors.dim(` (platform=${platform}${dryRun ? ', dry-run' : ''})`));

  // 1. 环境检测
  const report = detectAll({ platform, env });
  const coreOk = printReport(report, colors, { platform, log });

  // 2. 生成 / 合并 config（模板=config/hub.config.json，缺失用内置默认）
  log('');
  log(colors.bold('== 配置生成 / Config =='));
  try {
    const overrides = {
      port: options.port,
      sessionDir: options.sessionDir,
      workspaceRoot: options.workspaceRoot,
    };
    const res = ensureConfig({
      configPath: deps.configPath ?? defaultConfigPath(root),
      templatePath: deps.templatePath ?? defaultConfigPath(root),
      overrides,
      dryRun,
    });
    const action = res.created ? '已创建' : (res.wrote ? '已更新' : '已存在，无需改动');
    log(`${colors.ok} ${action}: ${res.path}${dryRun ? colors.dim(' [dry-run 未写盘]') : ''}`);
    log(colors.dim(`     port=${res.config.port} host=${res.config.host} sessionDir=${res.config.sessionDir} workspaceRoot=${res.config.workspaceRoot}`));
  } catch (e) {
    log(`${colors.fail} 配置处理失败（不崩溃，可修复后重跑）：${e.message}`);
  }

  // 3. --autostart 平台适配（失败仅提示）
  if (options.autostart) {
    log('');
    log(colors.bold('== 开机自启 / Autostart =='));
    const res = installAutostart({
      platform,
      home: deps.home,
      repoRoot: root,
      dryRun,
    });
    if (res.ok) {
      log(`${colors.ok} [${res.method}] ${res.detail.split('\n')[0]}`);
      if (dryRun) for (const line of res.detail.split('\n').slice(1)) log(colors.dim(line));
    } else {
      log(`${colors.warn} [${res.method}] ${res.detail}`);
    }
    for (const c of res.commands ?? []) log(colors.dim(`     手动命令: ${c}`));
  }

  // 4. 汇总 + 可选增强建议
  log('');
  log(colors.bold('== 汇总 / Summary =='));
  log(coreOk
    ? `${colors.ok} 核心环境就绪`
    : `${colors.fail} 核心依赖缺失（见上方提示；pi 不会自动安装，请手动执行建议命令）`);
  const missing = report.optional.filter((t) => !t.found);
  if (missing.length) {
    log('');
    log(colors.bold('可选增强建议 / Optional enhancements:'));
    for (const t of missing) {
      log(`  ${colors.yellow('-')} ${t.label}`);
      for (const line of String(installAdvice(t, platform)).split('\n')) log(`     ${colors.dim(line)}`);
    }
    log(colors.dim('  以上均为可选，缺失不影响会话列表 / chat / KPI。'));
  }
  if (isWindows(platform)) {
    log('');
    log(colors.info(' 原生 Windows：tmux 请走 WSL（wsl --install）或跳过。'));
  }
  log('');
  log(`下一步 / Next: ${colors.bold('node cli/start.js')}（--lan 局域网 / --tailscale 远程）`);
  return coreOk ? 0 : 1;
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`setup 失败: ${e.message}`);
      process.exit(1);
    });
}
