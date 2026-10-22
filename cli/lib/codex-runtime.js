import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_BUDGET_MS = 2_500;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_DIRECTORIES = 128;
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function positiveInt(value, fallback, max) {
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : fallback;
}

function versionFrom(value) {
  return typeof value === 'string' ? value.trim().match(VERSION_PATTERN)?.[1] ?? null : null;
}

/** 仅比较数字版本主干；构建/预发行标签不能证明协议更新。 */
export function compareCodexVersions(left, right) {
  const a = versionFrom(left)?.split(/[.+-]/).slice(0, 3).map(Number);
  const b = versionFrom(right)?.split(/[.+-]/).slice(0, 3).map(Number);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function within(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' })), Math.max(1, milliseconds));
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function acquire(promise, milliseconds) {
  try {
    return await within(promise, milliseconds);
  } catch (error) {
    // 超时的 open 仍可能稍后完成；届时释放文件句柄，不继续等待。
    void promise.then((handle) => handle.close()).catch(() => {});
    throw error;
  }
}

async function resolveBinary(configuredBin, context) {
  const { deps, env, platform, remaining } = context;
  const paths = platform === 'win32' ? path.win32 : path;
  const hasSeparator = /[/\\]/.test(configuredBin);
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const suffixes = platform === 'win32' && !paths.extname(configuredBin)
    ? (env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';') : [''];
  const roots = hasSeparator || paths.isAbsolute(configuredBin)
    ? [''] : pathValue.split(platform === 'win32' ? ';' : paths.delimiter).filter(Boolean).slice(0, 128);
  for (const root of roots) {
    for (const suffix of suffixes) {
      if (remaining() <= 0) return null;
      const candidate = root ? paths.resolve(root, configuredBin + suffix) : paths.resolve(configuredBin + suffix);
      try {
        await within(deps.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK), remaining());
        return await within(deps.realpath(candidate), remaining());
      } catch {
        // PATH 中缺失或不可访问的条目按普通失败处理，不输出环境内容。
      }
    }
  }
  return null;
}

function readRuntimeVersion(binary, context, timeoutMs) {
  const { deps, env, remaining } = context;
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let completed = false;
    let timer;
    const finish = (version, problem = null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ version, problem });
    };
    const fail = (problem) => {
      if (completed) return;
      try { child?.kill('SIGKILL'); } catch { /* best effort */ }
      finish(null, problem);
    };
    try {
      child = deps.spawn(binary, ['--version'], {
        env, shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      timer = setTimeout(() => {
        fail('timeout');
      }, Math.max(1, Math.min(timeoutMs, remaining())));
      child.stdout?.on('data', (chunk) => {
        // 版本应是一行短文本；不保留或打印异常输出。
        if (stdout.length < 8_192) stdout += String(chunk).slice(0, 8_192 - stdout.length);
      });
      child.stdout?.once('error', () => fail('unavailable'));
      child.once('error', () => fail('unavailable'));
      child.once('close', (code) => finish(code === 0 ? versionFrom(stdout.trim().replace(/^codex(?:-cli)?\s+/, '')) : null, code === 0 ? null : 'unavailable'));
    } catch {
      finish(null, 'unavailable');
    }
  });
}

async function sampleHistory(roots, context, limits) {
  const { deps, remaining } = context;
  const result = { version: null, sampledFiles: 0, unreadable: false, limited: false };
  const uniqueRoots = [...new Set(roots)];
  const perRoot = uniqueRoots.map(() => 0);
  const quotas = uniqueRoots.map((_root, index) => Math.floor(limits.maxFiles / uniqueRoots.length) + (index < limits.maxFiles % uniqueRoots.length ? 1 : 0));
  const pending = uniqueRoots.map((directory, root) => ({ directory, depth: 0, root }));
  let visited = 0;
  while (pending.length > 0 && result.sampledFiles < limits.maxFiles && visited < MAX_DIRECTORIES && remaining() > 0) {
    const { directory, depth, root } = pending.shift();
    if (perRoot[root] >= quotas[root]) { result.limited = true; continue; }
    visited += 1;
    let handle;
    const entries = [];
    try {
      // 按条目上限流式遍历目录，避免一次读取无界目录数组。
      handle = await acquire(deps.opendir(directory), remaining());
      for (let i = 0; i < MAX_DIRECTORY_ENTRIES && remaining() > 0; i += 1) {
        const entry = await within(handle.read(), remaining());
        if (!entry) break;
        entries.push(entry);
        if (i === MAX_DIRECTORY_ENTRIES - 1) result.limited = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') result.unreadable = true;
      // 定时器可能略早于毫秒时钟触发；I/O 已超时就不再启动下一次采样。
      if (error?.code === 'ETIMEDOUT') { result.limited = true; return result; }
    } finally {
      if (handle) void handle.close().catch(() => {});
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    const directories = [];
    for (const entry of entries) {
      if (remaining() <= 0 || result.sampledFiles >= limits.maxFiles || perRoot[root] >= quotas[root]) break;
      const file = path.join(directory, entry.name);
      // 不跟随符号链接读取凭据、配置或无关目录。
      if (entry.isDirectory() && depth < 4 && /^\d{2,4}$/.test(entry.name)) {
        directories.push({ directory: file, depth: depth + 1, root });
      } else if (entry.isFile() && /^rollout-.+\.jsonl$/i.test(entry.name)) {
        result.sampledFiles += 1;
        perRoot[root] += 1;
        let fileHandle;
        try {
          fileHandle = await acquire(deps.open(file, 'r'), remaining());
          const buffer = Buffer.alloc(limits.maxBytesPerFile);
          const { bytesRead } = await within(fileHandle.read(buffer, 0, buffer.length, 0), remaining());
          const bytes = buffer.subarray(0, bytesRead);
          const lineEnd = bytes.indexOf(0x0a);
          if (lineEnd < 0 && bytesRead === buffer.length) { result.limited = true; continue; }
          const row = JSON.parse(bytes.subarray(0, lineEnd < 0 ? bytesRead : lineEnd).toString('utf8'));
          const version = row?.type === 'session_meta' ? versionFrom(row.payload?.cli_version) : null;
          if (version && (result.version === null || compareCodexVersions(version, result.version) === 1)) result.version = version;
        } catch (error) {
          result.unreadable = true;
          if (error?.code === 'ETIMEDOUT') { result.limited = true; return result; }
        } finally {
          if (fileHandle) void fileHandle.close().catch(() => {});
        }
      }
    }
    if (perRoot[root] >= quotas[root]) result.limited = true;
    // 优先最新日期；每个根目录有独立配额，保证也能采样归档目录。
    pending.unshift(...directories);
  }
  if (pending.length > 0 || remaining() <= 0 || result.sampledFiles >= limits.maxFiles) result.limited = true;
  return result;
}

/**
 * 有界只读诊断，只执行所配置二进制的 --version；
 * 历史仅读取有限的 session_meta 头，不读取凭据、不调用模型。
 */
export async function inspectCodexRuntime(options = {}) {
  const configuredBin = typeof options.codexBin === 'string' && options.codexBin.trim() ? options.codexBin : 'codex';
  const deps = { spawn, access, realpath, opendir, open, now: Date.now, ...options.deps };
  const budgetMs = positiveInt(options.budgetMs, DEFAULT_BUDGET_MS, 10_000);
  const started = deps.now();
  const remaining = () => Math.max(0, budgetMs - (deps.now() - started));
  const context = { deps, env: options.env ?? process.env, platform: options.platform ?? process.platform, remaining };
  const codexHome = options.codexHome ?? context.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const report = {
    configuredBin, resolvedBin: null, runtimeVersion: null, historyVersion: null,
    compatibility: 'unknown', warnings: [], sampledFiles: 0, historyLimited: false,
  };
  try {
    // 独立读取并发执行，共用同一总时间预算。
    const [runtime, history] = await Promise.all([
      (async () => {
        const binary = await resolveBinary(configuredBin, context);
        if (!binary || remaining() <= 0) return { binary, version: null, problem: 'missing' };
        return { binary, ...await readRuntimeVersion(binary, context, positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10_000)) };
      })(),
      sampleHistory([
        options.sessionsDir ?? path.join(codexHome, 'sessions'),
        options.archivedSessionsDir ?? path.join(codexHome, 'archived_sessions'),
      ], context, {
        maxFiles: positiveInt(options.maxFiles, DEFAULT_MAX_FILES, 128),
        maxBytesPerFile: positiveInt(options.maxBytesPerFile, DEFAULT_MAX_BYTES, 256 * 1024),
      }),
    ]);
    report.resolvedBin = runtime.binary;
    report.runtimeVersion = runtime.version;
    report.historyVersion = history.version;
    report.sampledFiles = history.sampledFiles;
    report.historyLimited = history.limited;
    if (runtime.problem === 'missing') report.warnings.push('未找到配置的 Codex 可执行文件；运行版本未知。');
    else if (runtime.problem === 'timeout') report.warnings.push('Codex --version 超时；运行版本未知。');
    else if (!runtime.version) report.warnings.push('无法确认 Codex 运行版本（--version 执行失败或输出无法识别）。');
    if (history.unreadable) report.warnings.push('部分历史元数据无法读取或已损坏，历史版本采样可能不完整。');
    if (history.version === null) report.warnings.push('未观察到有效的历史 cli_version，历史兼容性未知。');
    const comparison = compareCodexVersions(runtime.version, history.version);
    if (comparison === -1) {
      report.compatibility = 'warning';
      report.warnings.push(`当前 Codex ${runtime.version} 低于采样历史版本 ${history.version}，继续旧会话可能存在协议兼容性问题；请核对 codexBin。`);
    } else if (comparison !== null) {
      report.compatibility = 'compatible';
    }
  } catch {
    // 诊断不得阻止启动；不回显异常原文、配置或命令输出。
    report.warnings.push('Codex 只读诊断未完成，运行时兼容性未知。');
  }
  return report;
}

export function formatCodexRuntimeDiagnostics(report) {
  return [
    `Codex 配置: ${report.configuredBin}`,
    `Codex 实际路径: ${report.resolvedBin ?? 'unknown'}`,
    `Codex 运行版本: ${report.runtimeVersion ?? 'unknown'}；采样历史最高版本: ${report.historyVersion ?? 'unknown'}（${report.sampledFiles} 个文件${report.historyLimited ? '，有采样上限' : ''}）`,
    `Codex 历史版本兼容性: ${report.compatibility}（仅版本诊断，未验证模型服务可用性）`,
    ...report.warnings.map((warning) => `Codex 警告: ${warning}`),
  ];
}
