// remote 一键远程入口：计划与子流程参数（纯函数，mock 不真实执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remotePlan, remoteChildArgs, PLAN_REASON_LABELS, main } from '../remote.js';

test('remotePlan: 缺 config → 首次自动 setup（missing-config）', () => {
  const plan = remotePlan({ hasConfig: false, hasDeps: false });
  assert.deepEqual(plan, { runSetup: true, reason: 'missing-config' });
});

test('remotePlan: config 在但缺依赖 → 仍先 setup（missing-deps）', () => {
  const plan = remotePlan({ hasConfig: true, hasDeps: false });
  assert.deepEqual(plan, { runSetup: true, reason: 'missing-deps' });
});

test('remotePlan: 已初始化 → 直接走 start（幂等）', () => {
  const plan = remotePlan({ hasConfig: true, hasDeps: true });
  assert.deepEqual(plan, { runSetup: false, reason: 'ready' });
});

test('remotePlan: --skip-setup 永不 setup', () => {
  const plan = remotePlan({ hasConfig: false, hasDeps: false, skipSetup: true });
  assert.deepEqual(plan, { runSetup: false, reason: 'skip-setup' });
});

test('remoteChildArgs: 默认使用 --tailscale，透传 port / dry-run / no-color / skip-build', () => {
  const { setupArgs, startArgs } = remoteChildArgs({ port: '8080', dryRun: true, color: false, skipBuild: true });
  assert.deepEqual(startArgs, ['--tailscale', '--port', '8080', '--dry-run', '--no-color', '--skip-build']);
  // start 的运行选项不得泄漏进 setup 的自启动注册选项
  assert.deepEqual(setupArgs, ['--port', '8080', '--dry-run', '--no-color']);
});

test('remoteChildArgs: 默认参数 → setup 无参、start 仅 --tailscale', () => {
  const { setupArgs, startArgs } = remoteChildArgs();
  assert.deepEqual(setupArgs, []);
  assert.deepEqual(startArgs, ['--tailscale']);
});

test('PLAN_REASON_LABELS: 每个计划原因都有展示文案', () => {
  for (const reason of ['missing-config', 'missing-deps', 'skip-setup', 'ready']) {
    assert.equal(typeof PLAN_REASON_LABELS[reason], 'string');
    assert.ok(PLAN_REASON_LABELS[reason].length > 0);
  }
});

test('remoteChildArgs: 可选局域网与跳过 Tailscale 均不触发 Serve', () => {
  assert.deepEqual(remoteChildArgs({ lan: true }).startArgs, ['--lan']);
  assert.deepEqual(remoteChildArgs({ tailscale: false }).startArgs, []);
});

for (const mode of [[], ['--lan'], ['--no-tailscale']]) {
  test(`remote 实际入口 ${mode.join(' ') || '默认'} dry-run：正确分流且不写配置`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-remote-mode-'));
    try {
      fs.mkdirSync(path.join(root, 'server/dist'), { recursive: true });
      fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'server/dist/index.js'), '');
      fs.writeFileSync(path.join(root, 'web/dist/index.html'), '');
      const configPath = path.join(root, 'hub.config.json');
      const config = JSON.stringify({ host: '127.0.0.1', port: 7700 });
      fs.writeFileSync(configPath, config);
      const lines = [];
      const code = await main([...mode, '--dry-run', '--skip-setup', '--no-color'], {
        root, configPath, nodeVersion: '22.19.0', log: line => lines.push(line),
      });
      assert.equal(code, 0);
      assert.equal(fs.readFileSync(configPath, 'utf8'), config);
      assert.equal(lines.some(line => line.includes('将检查 Tailscale 并配置 Serve')), mode.length === 0);
      assert.equal(lines.some(line => line.includes('LAN mode')), mode.includes('--lan'));
      assert.ok(lines.some(line => line.includes('dry-run 完成')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('remote 冲突模式在配置写入或 setup 前拒绝', async () => {
  const lines = [];
  assert.equal(await main(['--lan', '--tailscale'], { log: line => lines.push(line), root: '/does-not-exist' }), 1);
  assert.ok(lines.some(line => line.includes('不能同时使用')));
});
