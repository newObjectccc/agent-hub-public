#!/usr/bin/env node
// agent-hub check — 只读环境检测报告（不写任何文件、不注册任何任务）。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createColors } from './lib/color.js';
import { detectAll, installAdvice } from './lib/detect.js';
import { parseCliArgs, checkHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot } from './lib/paths.js';
import { isWindows } from './lib/process.js';

/**
 * 打印检测结果（setup / check 共用）。
 * @returns {boolean} 核心依赖是否齐备
 */
export function printReport(report, colors, { platform = process.platform, log = console.log } = {}) {
  log('');
  log(colors.bold('== 环境检测 / Environment check =='));
  log('');

  log(colors.bold('-- 核心依赖 / Core (required) --'));
  for (const t of report.core) {
    if (t.found && t.ok) {
      log(`${colors.ok} ${t.label}: ${t.version ?? t.raw ?? 'unknown'} ${colors.dim(`(${t.path})`)}`);
    } else if (t.found && !t.ok) {
      log(`${colors.fail} ${t.label}: ${t.raw || t.version || ''}`);
      log(`     ${colors.yellow(t.hint ?? '')}`);
    } else {
      log(`${colors.fail} ${t.label}: 未检测到 / not found`);
      log(`     ${colors.yellow(t.hint ?? '')}`);
    }
  }

  log('');
  log(colors.bold('-- 可选增强 / Optional enhancements --'));
  for (const t of report.optional) {
    if (t.found && t.ok) {
      log(`${colors.ok} ${t.label}: ${t.version ?? t.raw ?? 'unknown'} ${colors.dim(`(${t.path})`)}`);
    } else {
      log(`${colors.warn} ${t.label}: 未安装（可跳过，核心功能不受影响）`);
      const advice = installAdvice(t, platform);
      for (const line of String(advice).split('\n')) log(`     ${colors.dim(line)}`);
    }
  }

  if (isWindows(platform)) {
    log('');
    log(colors.info(' 原生 Windows：tmux 相关"终端直连"入口请走 WSL 或跳过，chat 功能不受影响。'));
  }
  return report.allCoreOk;
}

/** 只读检查 config 状态。 */
function reportConfig(configPath, colors, log) {
  log('');
  log(colors.bold('-- 配置 / Config --'));
  if (!fs.existsSync(configPath)) {
    log(`${colors.warn} ${configPath} 不存在，运行 \`node cli/setup.js\` 生成`);
    return;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log(`${colors.ok} ${configPath}`);
    log(`     port=${cfg.port} host=${cfg.host} sessionDir=${cfg.sessionDir ?? '-'} workspaceRoot=${cfg.workspaceRoot ?? '-'}`);
  } catch (e) {
    log(`${colors.fail} ${configPath} 解析失败: ${e.message}`);
  }
}

export async function main(argv = [], deps = {}) {
  const { options } = parseCliArgs(argv, {
    booleans: ['help', 'color', 'no-color'],
    allowPositionals: false,
  });
  if (options.help) {
    console.log(checkHelpText());
    return 0;
  }
  const colors = createColors({ enabled: options.color !== false && deps.useColor !== false });
  const root = deps.root ?? repoRoot();
  const report = detectAll({ platform: deps.platform, env: deps.env });
  const coreOk = printReport(report, colors, { platform: deps.platform ?? process.platform });
  reportConfig(deps.configPath ?? defaultConfigPath(root), colors, console.log);
  console.log('');
  console.log(coreOk
    ? `${colors.ok} 环境就绪。下一步：${colors.bold('node cli/start.js')}`
    : `${colors.fail} 核心依赖缺失，请先按上方提示安装。`);
  return coreOk ? 0 : 1;
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`check 失败: ${e.message}`);
      process.exit(1);
    });
}
