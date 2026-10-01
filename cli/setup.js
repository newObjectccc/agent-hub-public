#!/usr/bin/env node
// agent-hub setup — 一键准备：环境检测 → 安装依赖 → 生成 config → 可选安装 pi 扩展 → --autostart 平台适配。
// pi 缺失只提示安装方式（不自动全局安装）；tmux/ttyd/tailscale 缺失=建议，不算错误。
import { pathToFileURL } from 'node:url';
import { createColors } from './lib/color.js';
import { detectAll, installAdvice } from './lib/detect.js';
import { parseCliArgs, setupHelpText } from './lib/args.js';
import { defaultConfigPath, defaultConfigTemplatePath, repoRoot } from './lib/paths.js';
import { ensureConfig } from './lib/config.js';
import { installAutostart } from './lib/autostart.js';
import { installExtensions } from './lib/extensions.js';
import { installDeps, isWindows, resolvePackageManager } from './lib/process.js';
import { depsInstalled } from './start.js';
import { printReport } from './check.js';

export async function main(argv = [], deps = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, {
      booleans: ['autostart', 'skip-deps', 'extensions', 'dry-run', 'help', 'color'],
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

  // 2. 依赖安装（node_modules 缺失时 pnpm install，pnpm 缺失回退 npm；--skip-deps 跳过）
  log('');
  log(colors.bold('== 依赖安装 / Dependencies =='));
  if (options.skipDeps) {
    log(`${colors.info} --skip-deps：跳过依赖安装`);
  } else if (depsInstalled(root)) {
    log(`${colors.ok} 依赖已就绪（node_modules 完整）`);
  } else {
    const pm = resolvePackageManager({ platform, env });
    if (!pm.available) {
      log(`${colors.fail} 未找到 pnpm / npm。请先安装 Node.js ≥ 20（自带 npm），或用 --skip-deps 跳过。`);
    } else if (dryRun) {
      log(colors.dim(`  [dry-run] 将执行: ${pm.name} install (cwd=${root})`));
    } else {
      log(`${colors.info} 使用 ${pm.name} install 安装依赖（可能需要几分钟）…`);
      const res = installDeps(pm, { cwd: root, env, platform, timeout: 600_000 });
      if (res.ok) {
        log(`${colors.ok} 依赖安装完成`);
      } else {
        log(`${colors.fail} ${pm.name} install 失败: ${res.error || res.stderr.trim()}`);
        log(`  可修复后重跑 setup，或手动执行 ${colors.bold(`${pm.name} install`)}。`);
      }
    }
  }

  // 3. 生成 / 合并 config（模板=config/hub.config.example.json，缺失用内置默认）
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
      templatePath: deps.templatePath ?? defaultConfigTemplatePath(root),
      overrides,
      dryRun,
    });
    const action = res.created ? '已创建' : (res.wrote ? '已更新' : '已存在，无需改动');
    log(`${colors.ok} ${action}: ${res.path}${dryRun ? colors.dim(' [dry-run 未写盘]') : ''}`);
    log(colors.dim(`     port=${res.config.port} host=${res.config.host} sessionDir=${res.config.sessionDir} workspaceRoot=${res.config.workspaceRoot}`));
  } catch (e) {
    log(`${colors.fail} 配置处理失败（不崩溃，可修复后重跑）：${e.message}`);
  }

  // 4. 可选安装 pi 扩展（live-feed / pi-command 拷到 ~/.pi/agent/extensions/）
  //    默认策略：检测到 pi 才装（不打扰没装 pi 的用户）；--extensions 强制 / --no-extensions 跳过
  log('');
  log(colors.bold('== pi 扩展 / pi extensions =='));
  const piFound = report.tools.some((t) => t.name === 'pi' && t.found);
  const wantExtensions = options.extensions === true || (options.extensions === undefined && piFound);
  if (!wantExtensions) {
    log(options.extensions === false
      ? `${colors.info} --no-extensions：跳过 pi 扩展安装`
      : `${colors.warn} 未检测到 pi，跳过扩展安装（装好 pi 后重跑 setup 即可）`);
  } else {
    const STATUS_CN = {
      installed: '已安装',
      unchanged: '已存在且一致（跳过）',
      overwritten: '已更新为仓库版本',
      skipped: '跳过',
      failed: '失败',
    };
    const res = installExtensions({ root, home: deps.home, dryRun });
    log(`${res.ok ? colors.ok : colors.fail} 安装目录: ${res.dir}${dryRun ? colors.dim(' [dry-run 未写盘]') : ''}`);
    for (const r of res.results) {
      const mark = r.status === 'failed' ? colors.fail : (r.status === 'skipped' ? colors.warn : colors.ok);
      log(`  ${mark} ${r.label}: ${STATUS_CN[r.status] ?? r.status}${r.error ? colors.dim(`（${r.error}）`) : ''}`);
    }
    if (res.ok) {
      log(colors.dim('  扩展故障静默不阻塞 pi；推送地址/密钥可用环境变量 AGENT_HUB_LIVE_URL / AGENT_HUB_LIVE_TOKEN 覆盖。'));
    }
  }

  // 5. --autostart 平台适配（失败仅提示）
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

  // 6. 汇总 + 可选增强建议
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
    log(colors.dim('  以上均为可选，缺失不影响会话列表 / chat。'));
  }
  if (isWindows(platform)) {
    log('');
    log(colors.info(' 原生 Windows：tmux 请走 WSL（wsl --install）或跳过。'));
  }
  log('');
  log(`下一步 / Next: ${colors.bold('npm run start')}（或 node cli/start.js；--lan 局域网 / --tailscale 远程）`);
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
