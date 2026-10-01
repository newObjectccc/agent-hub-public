// remote 一键远程入口：计划与子流程参数（纯函数，mock 不真实执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePlan, remoteChildArgs, PLAN_REASON_LABELS } from '../remote.js';

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

test('remoteChildArgs: start 固定 --tailscale，透传 port / dry-run / no-color / skip-build', () => {
  const { setupArgs, startArgs } = remoteChildArgs({ port: '8080', dryRun: true, color: false, skipBuild: true });
  assert.deepEqual(startArgs, ['--tailscale', '--port', '8080', '--dry-run', '--no-color', '--skip-build']);
  // setup 不认识 --skip-build / --tailscale，不得透传
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
