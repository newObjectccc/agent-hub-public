#!/usr/bin/env node
// agent-hub check — 只读环境检测报告（不写任何文件、不注册任何任务）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectRun as isDirectRunCheck } from './lib/entry.js';
import { createColors } from './lib/color.js';
import { detectAll, installAdvice } from './lib/detect.js';
import { parseNetcheck, latencyAdvice } from './lib/net.js';
import { parseCliArgs, checkHelpText } from './lib/args.js';
import { defaultConfigPath, repoRoot, expandHome } from './lib/paths.js';
import { isWindows, runCapture, findCommand } from './lib/process.js';
import { inspectCodexRuntime, formatCodexRuntimeDiagnostics } from './lib/codex-runtime.js';

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
      const detail = t.broken
        ? `检测到二进制但不可用${t.raw ? `（${t.raw}）` : ''}`
        : (t.raw || t.version || '');
      log(`${colors.fail} ${t.label}: ${detail}`);
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
    } else if (t.found && t.broken) {
      log(`${colors.warn} ${t.label}: 检测到二进制但不可用${t.raw ? `（${t.raw}）` : ''} ${colors.dim(`(${t.path})`)}`);
      for (const line of String(t.hint ?? '').split('\n')) log(`     ${colors.yellow(line)}`);
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
export function reportConfig(configPath, colors, log) {
  log('');
  log(colors.bold('-- 配置 / Config --'));
  if (!fs.existsSync(configPath)) {
    log(`${colors.warn} ${configPath} 不存在，运行 \`npm run setup\`（或 node cli/setup.js）生成`);
    return 'codex';
  }
  try {
    const { codexBin } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log(`${colors.ok} ${configPath}`);
    if (typeof codexBin !== 'string' || !codexBin.trim() || /[\0\r\n]/.test(codexBin)) return 'codex';
    const bin = codexBin.trim();
    return /[\\/]/.test(bin) || bin === '~' ? path.resolve(path.dirname(configPath), expandHome(bin)) : bin;
  } catch {
    // JSON 解析异常可能带出配置里的 token，错误只给通用提示。
    log(`${colors.fail} ${configPath} 解析失败`);
    return 'codex';
  }
}

/** 可选只读诊断，失败不改变核心依赖的退出状态。 */
export async function reportCodexRuntime(colors, log, options = {}, inspect = inspectCodexRuntime) {
  log('');
  log(colors.bold('-- Codex 运行时 / Runtime (read-only) --'));
  try {
    const report = await inspect(options);
    for (const line of formatCodexRuntimeDiagnostics(report)) log(`     ${line}`);
  } catch {
    log(`${colors.warn} Codex 运行时诊断未完成，兼容性未知`);
  }
}

/** 只读远程链路延迟体检（tailscale netcheck 解析 + 可操作建议）。tailscale 缺失时跳过（不致命）。 */
export function reportLatency(colors, log, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    run = runCapture,
    find = findCommand,
  } = deps;
  log('');
  log(colors.bold('-- 链路延迟体检 / Remote latency (Tailscale) --'));
  const locate = find('tailscale', { platform, env, run });
  if (!locate.found) {
    log(`${colors.warn} 未检测到 tailscale（手机远程需要；纯局域网 --lan 模式可忽略）`);
    return;
  }
  const res = run('tailscale', ['netcheck'], { env, shell: isWindows(platform), timeout: 20_000 });
  const report = parseNetcheck(res.stdout);
  if (!res.ok || !report.ok) {
    log(`${colors.warn} netcheck 执行/解析失败（${res.error || res.stderr.trim() || '未知原因'}），可手动执行 \`tailscale netcheck\` 自查`);
    return;
  }
  log(` UDP=${report.udp ? 'yes' : 'NO'}  IPv4=${report.ipv4 ?? '无'}  IPv6=${report.ipv6 ?? (report.ipv6OsSupport ? '无（OS 已支持）' : '无')}`);
  log(` NAT=${report.mappingVariesByDestIP === true ? '对称（打洞难）' : '锥形（打洞友好）'}  端口映射=${report.portMapping ?? '无'}  最近 DERP=${report.nearestDerp ?? '?'}${report.minDerpLatencyMs !== null ? ` (${report.minDerpLatencyMs}ms)` : ''}`);
  const advice = latencyAdvice(report);
  if (advice.length === 0) {
    log(`${colors.ok} 直连条件良好：预期 P2P 直连 <50ms。验证：${colors.bold('tailscale ping <手机 Tailscale IP>')} 出现 direct 即成功`);
    return;
  }
  for (const line of advice) {
    for (const part of line.split('\n')) log(`     ${colors.yellow(part)}`);
  }
  log(`     ${colors.dim('指标解读与优化步骤见 README「⚠️ 延迟警告」一节')}`);
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
  const codexBin = reportConfig(deps.configPath ?? defaultConfigPath(root), colors, console.log);
  await reportCodexRuntime(colors, console.log, {
    codexBin,
    env: deps.env ?? process.env,
    ...(deps.codexRuntimeOptions ?? {}),
  }, deps.inspectCodexRuntime ?? inspectCodexRuntime);
  reportLatency(colors, console.log, {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    run: deps.run,
    find: deps.find,
  });
  console.log('');
  console.log(coreOk
    ? `${colors.ok} 环境就绪。下一步：${colors.bold('npm run start')}`
    : `${colors.fail} 核心依赖缺失，请先按上方提示安装。`);
  return coreOk ? 0 : 1;
}

// 直接执行入口（被 cli.js 分发时不触发）
const isDirectRun = isDirectRunCheck(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`check 失败: ${e.message}`);
      process.exit(1);
    });
}
