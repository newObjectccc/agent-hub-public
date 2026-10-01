// config 生成 / 合并逻辑测试（临时目录，真实读写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOverrides, ensureConfig, loadConfig, DEFAULT_CONFIG } from '../lib/config.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('applyOverrides: 覆盖 port / sessionDir / workspaceRoot，未知字段保留', () => {
  const base = { ...DEFAULT_CONFIG, customFlag: true };
  const next = applyOverrides(base, {
    port: '8080',
    sessionDir: '~/.pi/sessions2',
    workspaceRoot: '~/Work',
    host: undefined,
  });
  assert.equal(next.port, 8080);
  assert.equal(next.sessionDir, '~/.pi/sessions2');
  assert.equal(next.workspaceRoot, '~/Work');
  assert.equal(next.host, '127.0.0.1'); // 未提供保持原值
  assert.equal(next.customFlag, true); // 未知字段保留
  assert.equal(base.port, 7700); // 不改原对象
});

test('applyOverrides: 非法 port 抛错', () => {
  assert.throws(() => applyOverrides({}, { port: '0' }), /端口无效/);
  assert.throws(() => applyOverrides({}, { port: '65536' }), /端口无效/);
  assert.throws(() => applyOverrides({}, { port: 'abc' }), /端口无效/);
});

test('ensureConfig: 不存在时从模板复制并应用覆盖', (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, 'config', 'hub.config.json');
  const templatePath = path.join(dir, 'template.json');
  fs.writeFileSync(templatePath, JSON.stringify({ ...DEFAULT_CONFIG, port: 7000 }), 'utf8');

  const res = ensureConfig({ configPath, templatePath, overrides: { port: '7001' } });
  assert.equal(res.created, true);
  assert.equal(res.wrote, true);
  assert.equal(res.config.port, 7001);
  const onDisk = loadConfig(configPath);
  assert.equal(onDisk.port, 7001);
  assert.equal(onDisk.host, '127.0.0.1');
});

test('ensureConfig: 模板缺失时用内置默认', (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, 'hub.config.json');
  const res = ensureConfig({ configPath, templatePath: path.join(dir, 'nope.json'), overrides: {} });
  assert.equal(res.created, true);
  assert.equal(res.config.port, DEFAULT_CONFIG.port);
  assert.equal(res.config.sessionDir, DEFAULT_CONFIG.sessionDir);
  assert.ok(fs.existsSync(configPath));
});

test('ensureConfig: 已存在则合并覆盖、保留未知字段、不整体覆盖', (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, 'hub.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 7700,
    host: '127.0.0.1',
    kpiRefreshMinutes: 9,
    futureKey: { keep: 'me' },
  }), 'utf8');

  const res = ensureConfig({ configPath, templatePath: configPath, overrides: { workspaceRoot: '~/WS' } });
  assert.equal(res.created, false);
  assert.equal(res.wrote, true);
  assert.equal(res.config.kpiRefreshMinutes, 9);
  assert.deepEqual(res.config.futureKey, { keep: 'me' });
  assert.equal(res.config.workspaceRoot, '~/WS');
  const onDisk = loadConfig(configPath);
  assert.deepEqual(onDisk.futureKey, { keep: 'me' });
});

test('ensureConfig: 已存在且无覆盖不回写', (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, 'hub.config.json');
  const original = JSON.stringify({ port: 7700 }, null, 2);
  fs.writeFileSync(configPath, original, 'utf8');

  const res = ensureConfig({ configPath, templatePath: configPath, overrides: {} });
  assert.equal(res.created, false);
  assert.equal(res.wrote, false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('ensureConfig: dry-run 不落盘', (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, 'hub.config.json');
  const res = ensureConfig({ configPath, templatePath: configPath, overrides: { port: '9000' }, dryRun: true });
  assert.equal(res.created, true);
  assert.equal(res.config.port, 9000);
  assert.equal(fs.existsSync(configPath), false);
});

test('ensureConfig: 新建时 workspaceRoot 目录不存在 → 回落 home 并标记 fallback', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const configPath = path.join(dir, 'hub.config.json');
  // 模板缺失 → 用内置默认（workspaceRoot: ~/Workspace，home 下不存在）
  const res = ensureConfig({ configPath, templatePath: path.join(dir, 'nope.json'), overrides: {}, home });
  assert.equal(res.created, true);
  assert.equal(res.workspaceRootFallback, true);
  assert.equal(res.config.workspaceRoot, '~');
  assert.equal(loadConfig(configPath).workspaceRoot, '~');
});

test('ensureConfig: 新建时 workspaceRoot 目录存在 → 保留模板默认', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'Workspace'), { recursive: true });
  const configPath = path.join(dir, 'hub.config.json');
  const res = ensureConfig({ configPath, templatePath: path.join(dir, 'nope.json'), overrides: {}, home });
  assert.equal(res.workspaceRootFallback, false);
  assert.equal(res.config.workspaceRoot, '~/Workspace');
});

test('ensureConfig: 显式 --workspace-root 不回落（即使目录不存在）', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const configPath = path.join(dir, 'hub.config.json');
  const res = ensureConfig({
    configPath,
    templatePath: path.join(dir, 'nope.json'),
    overrides: { workspaceRoot: '~/Explicit' },
    home,
  });
  assert.equal(res.workspaceRootFallback, false);
  assert.equal(res.config.workspaceRoot, '~/Explicit');
});

test('ensureConfig: 已有 config 不动（幂等），即使 workspaceRoot 目录不存在', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const configPath = path.join(dir, 'hub.config.json');
  const original = JSON.stringify({ port: 7700, workspaceRoot: '~/Missing' }, null, 2);
  fs.writeFileSync(configPath, original, 'utf8');

  const res = ensureConfig({ configPath, templatePath: configPath, overrides: {}, home });
  assert.equal(res.created, false);
  assert.equal(res.wrote, false);
  assert.equal(res.workspaceRootFallback, false);
  assert.equal(res.config.workspaceRoot, '~/Missing');
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});
