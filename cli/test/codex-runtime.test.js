import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { inspectCodexRuntime, compareCodexVersions, formatCodexRuntimeDiagnostics } from '../lib/codex-runtime.js';
import { reportCodexRuntime, reportConfig } from '../check.js';
import { createColors } from '../lib/color.js';

test('doctor 的二进制路径与 server 一致：相对配置目录、展开 ~、命令去空格', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'hub-codex-path-'));
  const config = path.join(base, 'config.json');
  const colors = createColors({ enabled: false });
  try {
    for (const [value, expected] of [['./tools/my codex', path.join(base, 'tools/my codex')], ['~/tools/codex', path.join(homedir(), 'tools/codex')], [' codex-custom ', 'codex-custom'], ['codex\ncommand', 'codex']]) {
      await writeFile(config, JSON.stringify({ codexBin: value }));
      assert.equal(reportConfig(config, colors, () => {}), expected);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

function mockSpawn(output = 'codex-cli 0.159.0\n', { hangs = false, code = 0 } = {}) {
  const calls = []; const signals = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = (signal) => { signals.push(signal); return true; };
    if (!hangs) queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); });
    return child;
  };
  return { spawn, calls, signals };
}

async function fixture(runOutput) {
  const base = await mkdtemp(path.join(tmpdir(), 'agent-hub-codex-diagnostic-'));
  const bin = path.join(base, 'bin with spaces', 'codex');
  const codexHome = path.join(base, 'codex home');
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(bin, 'fixture; never execute'); await chmod(bin, 0o755);
  const process = mockSpawn(runOutput);
  const options = { codexBin: bin, codexHome, deps: { spawn: process.spawn } };
  const history = async (version, { archived = false, name = 'one', suffix = '' } = {}) => {
    const dir = path.join(codexHome, archived ? 'archived_sessions' : 'sessions/2026/10/16');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-${name}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { cli_version: version } })}\n${suffix}`);
    return file;
  };
  return { base, bin, codexHome, options, process, history, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('Codex diagnostics preserve a spaced executable path and only run --version without a shell', async () => {
  const f = await fixture();
  try {
    await f.history('0.159.0');
    const result = await inspectCodexRuntime(f.options);
    assert.equal(result.configuredBin, f.bin); assert.equal(result.resolvedBin, await realpath(f.bin));
    assert.equal(result.runtimeVersion, '0.159.0'); assert.equal(result.historyVersion, '0.159.0');
    assert.equal(result.compatibility, 'compatible'); assert.deepEqual(result.warnings, []);
    assert.equal(f.process.calls.length, 1);
    assert.deepEqual(f.process.calls[0].args, ['--version']);
    assert.equal(f.process.calls[0].options.shell, false);
  } finally { await f.cleanup(); }
});

test('Codex PATH resolution and CODEX_HOME use the injected environment', async () => {
  const f = await fixture();
  try {
    await f.history('0.159.0');
    const result = await inspectCodexRuntime({ codexBin: 'codex', env: { PATH: path.dirname(f.bin), CODEX_HOME: f.codexHome }, deps: f.options.deps });
    assert.equal(result.resolvedBin, await realpath(f.bin)); assert.equal(result.historyVersion, '0.159.0');
  } finally { await f.cleanup(); }
});

test('Codex compares numeric release cores and warns only when runtime is older', async () => {
  assert.equal(compareCodexVersions('0.99.0', '0.159.0'), -1);
  assert.equal(compareCodexVersions('0.159.0-alpha.1', '0.159.0+build.8'), 0);
  assert.equal(compareCodexVersions('2.0.0', '1.999.0'), 1);
  assert.equal(compareCodexVersions('unknown', '0.159.0'), null);
  const f = await fixture('codex-cli 0.143.0\n');
  try {
    await f.history('0.140.0'); await f.history('0.159.0', { archived: true });
    const result = await inspectCodexRuntime(f.options);
    assert.equal(result.historyVersion, '0.159.0'); assert.equal(result.compatibility, 'warning');
    assert.match(result.warnings.join('\n'), /低于采样历史版本/);
    f.options.deps.spawn = mockSpawn('codex-cli 0.160.0\n').spawn;
    const newer = await inspectCodexRuntime(f.options);
    assert.equal(newer.compatibility, 'compatible'); assert.deepEqual(newer.warnings, []);
  } finally { await f.cleanup(); }
});

test('Codex samples both history roots with file/byte caps and never opens credentials or config', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i += 1) await f.history('0.140.0', { name: `active-${i}`, suffix: 'PRIVATE CHAT BODY'.repeat(1_000) });
    await f.history('0.160.0', { archived: true });
    await writeFile(path.join(f.codexHome, 'auth.json'), 'SECRET');
    await writeFile(path.join(f.codexHome, 'config.toml'), 'SECRET');
    const opened = []; const lengths = [];
    const result = await inspectCodexRuntime({ ...f.options, maxFiles: 3, maxBytesPerFile: 128, deps: {
      ...f.options.deps,
      open: async (file, mode) => {
        assert.match(file, /rollout-.+\.jsonl$/); assert.equal(mode, 'r'); opened.push(file);
        const handle = await open(file, mode);
        return { read: (...args) => { lengths.push(args[2]); return handle.read(...args); }, close: () => handle.close() };
      },
    } });
    assert.equal(result.sampledFiles, 3); assert.equal(opened.length, 3);
    assert.equal(result.historyVersion, '0.160.0'); assert.equal(result.historyLimited, true);
    assert.ok(lengths.every((length) => length <= 128));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CHAT BODY|SECRET/);
  } finally { await f.cleanup(); }
});

test('Codex missing executable/history, damaged metadata and permission errors degrade softly', async () => {
  const missing = await inspectCodexRuntime({ codexBin: 'codex', env: { PATH: '' }, codexHome: '/does/not/exist', deps: { spawn: () => { throw new Error('must not spawn'); } } });
  assert.equal(missing.compatibility, 'unknown'); assert.equal(missing.resolvedBin, null);
  assert.match(missing.warnings.join('\n'), /未找到/);
  const f = await fixture();
  try {
    const file = await f.history('bad-version'); await writeFile(file, '{broken\nSECRET CONTENT');
    const damaged = await inspectCodexRuntime(f.options);
    assert.equal(damaged.historyVersion, null); assert.equal(damaged.compatibility, 'unknown');
    assert.match(damaged.warnings.join('\n'), /损坏/);
    const denied = await inspectCodexRuntime({ ...f.options, deps: { ...f.options.deps, opendir: async () => { throw Object.assign(new Error('SECRET'), { code: 'EACCES' }); } } });
    assert.equal(denied.compatibility, 'unknown'); assert.doesNotMatch(JSON.stringify(denied), /SECRET/);
  } finally { await f.cleanup(); }
});

test('Codex --version times out and never exposes raw command output', async () => {
  const f = await fixture();
  try {
    const process = mockSpawn('', { hangs: true });
    const result = await inspectCodexRuntime({ ...f.options, timeoutMs: 15, budgetMs: 100, deps: { spawn: process.spawn } });
    assert.equal(result.runtimeVersion, null); assert.deepEqual(process.signals, ['SIGKILL']);
    assert.match(result.warnings.join('\n'), /超时/);
    const unexpected = await inspectCodexRuntime({ ...f.options, deps: { spawn: mockSpawn('Error: SECRET_TOKEN 9.9.9').spawn } });
    assert.equal(unexpected.runtimeVersion, null); assert.doesNotMatch(JSON.stringify(unexpected), /SECRET_TOKEN/);
  } finally { await f.cleanup(); }
});

test('Codex history I/O obeys the total budget and closes a handle acquired after timeout', async () => {
  const f = await fixture();
  let lateResolve; let closed = 0;
  const pending = new Promise((resolve) => { lateResolve = resolve; });
  try {
    const started = Date.now();
    const result = await inspectCodexRuntime({ ...f.options, budgetMs: 35, deps: { ...f.options.deps, opendir: () => pending } });
    assert.ok(Date.now() - started < 500);
    assert.equal(result.runtimeVersion, '0.159.0'); assert.equal(result.historyLimited, true);
    assert.equal(result.compatibility, 'unknown');
    lateResolve({ close: async () => { closed += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
  } finally { await f.cleanup(); }
});

test('Codex history I/O timeout stops further sampling even if the clock still has budget', async () => {
  const f = await fixture();
  try {
    await f.history('0.159.0', { name: 'one' });
    await f.history('0.160.0', { name: 'two' });
    for (const stage of ['directory', 'open', 'read']) {
      let directoryCalls = 0; let fileCalls = 0; let closed = 0;
      const timeout = () => Object.assign(new Error('SECRET TIMEOUT PAYLOAD'), { code: 'ETIMEDOUT' });
      const result = await inspectCodexRuntime({ ...f.options, deps: {
        ...f.options.deps,
        // 模拟定时器已超时、毫秒时钟仍略早的边界，避免依赖调度速度。
        now: () => 0,
        ...(stage === 'directory' ? { opendir: async () => { directoryCalls += 1; throw timeout(); } } : {}),
        open: async () => {
          fileCalls += 1;
          if (stage === 'open') throw timeout();
          return { read: async () => { throw timeout(); }, close: async () => { closed += 1; } };
        },
      } });
      assert.equal(result.runtimeVersion, '0.159.0', stage);
      assert.equal(result.historyVersion, null, stage);
      assert.equal(result.historyLimited, true, stage);
      assert.equal(directoryCalls, stage === 'directory' ? 1 : 0, stage);
      assert.equal(fileCalls, stage === 'directory' ? 0 : 1, stage);
      assert.equal(closed, stage === 'read' ? 1 : 0, stage);
      assert.doesNotMatch(JSON.stringify(result), /SECRET TIMEOUT PAYLOAD/);
    }
  } finally { await f.cleanup(); }
});

test('Codex formatting/check extracts only codexBin and never prints tokens or parser excerpts', async () => {
  const f = await fixture(); const logs = []; const colors = createColors({ enabled: false });
  try {
    const config = path.join(f.base, 'config.json');
    await writeFile(config, JSON.stringify({ codexBin: f.bin, token: 'SECRET_TOKEN', model: 'PRIVATE_MODEL' }));
    assert.equal(reportConfig(config, colors, (line) => logs.push(line)), f.bin);
    await reportCodexRuntime(colors, (line) => logs.push(line), f.options);
    assert.match(logs.join('\n'), /Codex 运行版本/);
    assert.doesNotMatch(logs.join('\n'), /SECRET_TOKEN|PRIVATE_MODEL/);
    logs.length = 0; await writeFile(config, '{"token":"SECRET_TOKEN",bad}');
    reportConfig(config, colors, (line) => logs.push(line));
    assert.doesNotMatch(logs.join('\n'), /SECRET_TOKEN/);
    const result = await inspectCodexRuntime(f.options);
    assert.match(formatCodexRuntimeDiagnostics(result).join('\n'), /未验证模型服务可用性/);
    await reportCodexRuntime(colors, (line) => logs.push(line), {}, async () => { throw new Error('SECRET_TOKEN'); });
    assert.doesNotMatch(logs.join('\n'), /SECRET_TOKEN/);
  } finally { await f.cleanup(); }
});
