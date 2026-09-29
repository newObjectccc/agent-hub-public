// 检测结果解析测试（mock 命令输出，不真实执行命令）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersionOutput,
  versionAtLeast,
  detectTool,
  detectAll,
  installAdvice,
  TOOLS,
} from '../lib/detect.js';

const ok = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', error: null });
const fail = (stderr) => ({ ok: false, status: 1, stdout: '', stderr, error: null });

/** 构造 mock deps：find 命中固定路径，run 按命令返回输出 */
function mockDeps({ found = true, outputs = {}, platform = 'linux' } = {}) {
  return {
    platform,
    env: {},
    find: (cmd) => (found ? { found: true, path: `/mock/bin/${cmd}` } : { found: false, path: null }),
    run: (cmd, args) => {
      const key = `${cmd} ${(args ?? []).join(' ')}`.trim();
      const out = outputs[key] ?? outputs[cmd];
      return out ?? ok('');
    },
  };
}

test('parseVersionOutput: 提取版本号与首行', () => {
  assert.deepEqual(parseVersionOutput('v20.11.0'), { version: '20.11.0', firstLine: 'v20.11.0' });
  assert.deepEqual(parseVersionOutput('tmux 3.4\n'), { version: '3.4', firstLine: 'tmux 3.4' });
  assert.deepEqual(parseVersionOutput('pi version 0.87.1 (build 123)'), {
    version: '0.87.1',
    firstLine: 'pi version 0.87.1 (build 123)',
  });
  assert.deepEqual(parseVersionOutput(''), { version: null, firstLine: '' });
  assert.deepEqual(parseVersionOutput('no numbers here'), { version: null, firstLine: 'no numbers here' });
});

test('versionAtLeast: 语义化版本比较', () => {
  assert.equal(versionAtLeast('20.11.0', '20.0.0'), true);
  assert.equal(versionAtLeast('v20.0.0', '20.0.0'), true);
  assert.equal(versionAtLeast('19.9.9', '20.0.0'), false);
  assert.equal(versionAtLeast('20.0', '20.0.0'), true);
  assert.equal(versionAtLeast(null, '20.0.0'), false);
});

test('detectTool: 命中命令时解析版本（mock pi --version）', () => {
  const deps = mockDeps({ outputs: { 'pi --version': ok('pi version 0.87.1') } });
  const t = detectTool('pi', deps);
  assert.equal(t.found, true);
  assert.equal(t.version, '0.87.1');
  assert.equal(t.ok, true);
  assert.equal(t.path, '/mock/bin/pi');
});

test('detectTool: 未命中命令 → found=false，可选 ok=true / 必选 ok=false', () => {
  const tmux = detectTool('tmux', mockDeps({ found: false }));
  assert.equal(tmux.found, false);
  assert.equal(tmux.ok, true); // 可选增强不算错误
  assert.ok(tmux.hint.length > 0);

  const pi = detectTool('pi', mockDeps({ found: false }));
  assert.equal(pi.found, false);
  assert.equal(pi.ok, false); // 核心依赖缺失
  assert.match(pi.hint, /@earendil-works\/pi-coding-agent/);
  assert.match(pi.hint, /npx/);
});

test('detectTool: node 版本过低时 ok=false 并提示升级', () => {
  const t = detectTool('node', mockDeps({ outputs: { 'node --version': ok('v18.20.0') } }));
  assert.equal(t.found, true);
  assert.equal(t.version, '18.20.0');
  assert.equal(t.ok, false);
  assert.match(t.hint, /20\.0\.0/);
});

test('detectTool: tailscale 用 `tailscale version` 检测', () => {
  const deps = mockDeps({ outputs: { 'tailscale version': ok('1.66.0\n  go version: go1.22') } });
  const t = detectTool('tailscale', deps);
  assert.equal(t.found, true);
  assert.equal(t.version, '1.66.0');
});

test('detectTool: 命令输出在 stderr 也可解析（如 tmux -V）', () => {
  const deps = {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/mock/bin/tmux' }),
    run: () => fail('tmux 3.4'),
  };
  const t = detectTool('tmux', deps);
  assert.equal(t.version, '3.4');
});

test('detectAll: 核心/可选分组正确', () => {
  const report = detectAll(mockDeps({
    outputs: {
      'node --version': ok('v20.11.0'),
      'pi --version': ok('pi version 0.87.1'),
    },
  }));
  assert.equal(report.core.length, 2);
  assert.equal(report.optional.length, 3);
  assert.equal(report.allCoreOk, true);
  assert.ok(report.tools.some((t) => t.name === 'tailscale'));
});

test('installAdvice: 原生 Windows 的 tmux 给 WSL 指引', () => {
  const advice = installAdvice(TOOLS.tmux, 'win32');
  assert.match(advice, /WSL/);
  assert.match(advice, /wsl --install/);
  // 其他平台给 brew/apt 命令
  assert.match(installAdvice(TOOLS.tmux, 'darwin'), /brew install tmux/);
  assert.match(installAdvice(TOOLS.tmux, 'linux'), /apt install tmux/);
});

test('installAdvice: 接受检测结果对象（无 hints 字段）也返回平台命令', () => {
  const detectResult = detectTool('ttyd', mockDeps({ found: false }));
  assert.match(installAdvice(detectResult, 'darwin'), /brew install ttyd/);
  assert.match(installAdvice(detectResult, 'linux'), /apt install ttyd/);
  assert.match(installAdvice(detectResult, 'win32'), /ttyd\/releases/);
  assert.match(installAdvice('tailscale', 'linux'), /tailscale\.com\/install\.sh/);
});

test('hintFor 覆盖三平台安装建议', () => {
  assert.match(TOOLS.tailscale.hints.linux, /tailscale\.com\/install\.sh/);
  assert.match(TOOLS.tailscale.hints.win32, /download\/windows/);
  assert.match(TOOLS.ttyd.hints.darwin, /brew install ttyd/);
});
