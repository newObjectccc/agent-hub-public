#!/usr/bin/env node
// CLI 发布包需要自己的依赖锁；依赖包内的 overrides 不会被 npm 消费者继承。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommand } from '../cli/lib/process.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.deepEqual(pkg.overrides, pkg.pnpm?.overrides, 'npm 与 pnpm 的安全覆盖必须一致');
const located = findCommand('npm').path;
assert(located, '需要 npm');
const npmCli = [realpathSync(located), join(dirname(located), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(located), '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => basename(candidate) === 'npm-cli.js' && existsSync(candidate));
assert(npmCli, '找不到 npm-cli.js');

// 直接依赖与当前 pnpm 冻结安装保持一致，避免生成发布锁时偷偷更新顶层 SDK。
const dependencies = Object.fromEntries(Object.keys(pkg.dependencies).map(name => {
  const installed = JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
  return [name, installed.version];
}));
const owned = mkdtempSync(join(tmpdir(), 'agent-hub-npm-lock-'));
chmodSync(owned, 0o700);
try {
  const userConfig = join(owned, 'empty-user.npmrc'), globalConfig = join(owned, 'empty-global.npmrc');
  for (const file of [userConfig, globalConfig]) writeFileSync(file, '', { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  env.NPM_CONFIG_USERCONFIG = userConfig;
  env.NPM_CONFIG_GLOBALCONFIG = globalConfig;
  writeFileSync(join(owned, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, license: pkg.license,
    engines: pkg.engines, bin: pkg.bin, dependencies, overrides: pkg.overrides,
    bundledDependencies: pkg.bundledDependencies,
    pnpm: {
      overrides: pkg.overrides,
      supportedArchitectures: pkg.pnpm?.supportedArchitectures,
      patchedDependencies: Object.fromEntries(Object.entries(pkg.pnpm?.patchedDependencies ?? {}).map(([name, file]) => [name, resolve(root, file)])),
    },
  }, null, 2), { mode: 0o600 });
  // 上游 SDK 自带旧 shrinkwrap；先用 pnpm 的安全覆盖生成普通 node_modules 布局，
  // 再让 npm 从实际解析树生成 CLI 应用锁，避免 npm 重新导入上游的旧锁。
  const installed = spawnSync('pnpm', ['install', '--prod', '--ignore-scripts', '--node-linker=hoisted', '--registry=https://registry.npmjs.org/'], {
    cwd: owned, env, stdio: 'inherit', timeout: 300_000, shell: process.platform === 'win32',
  });
  assert(!installed.error && installed.status === 0, '发布依赖解析失败');
  const shrink = spawnSync(process.execPath, [npmCli, 'shrinkwrap', '--ignore-scripts'], { cwd: owned, env, stdio: 'inherit', timeout: 300_000 });
  assert(!shrink.error && shrink.status === 0, 'npm 发布锁生成失败');
  const lock = JSON.parse(readFileSync(join(owned, 'npm-shrinkwrap.json'), 'utf8'));
  lock.packages[''].dependencies = pkg.dependencies;
  const undici = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/undici$/.test(name));
  assert(undici.length > 0 && undici.every(([, value]) => value.version === '8.12.2'), `发布锁的 Undici 版本不符合修补策略：${undici.map(([, value]) => value.version).join(', ')}`);
  writeFileSync(join(root, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log('npm-shrinkwrap.json 已更新；CLI 安装产物将锁定 Undici 8.12.2。');
} finally {
  rmSync(owned, { recursive: true, force: true });
}
