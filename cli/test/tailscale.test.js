import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTailscale, tailscaleRunOptions, tailscaleCommandPrefix, tailscaleInstallGuide } from '../lib/tailscale.js';

const missing = () => ({ found: false, path: null });

test('Tailscale 可选：不存在时只查找，不下载或启动客户端', () => {
  assert.deepEqual(findTailscale({
    platform: 'darwin', env: {}, home: '/fixture', find: missing,
    exists: () => false, run: () => { throw new Error('must not execute'); },
  }), { found: false, path: null });
});

test('Tailscale 查找尊重 PATH 中的已有安装', () => {
  assert.deepEqual(findTailscale({
    platform: 'darwin', env: {}, find: () => ({ found: true, path: '/custom/tailscale' }),
    exists: () => { throw new Error('must not look for another installation'); },
  }), { found: true, path: '/custom/tailscale' });
});

test('macOS 用户目录与 Windows Program Files 的客户端无需手动改 PATH', () => {
  const mac = '/fixture/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  assert.equal(findTailscale({ platform: 'darwin', home: '/fixture', env: {}, find: missing, exists: file => file === mac }).path, mac);
  const win = 'D:\\Program Files\\Tailscale\\tailscale.exe';
  assert.equal(findTailscale({ platform: 'win32', env: { ProgramFiles: 'D:\\Program Files' }, find: missing, exists: file => file === win }).path, win);
  assert.equal(tailscaleRunOptions({ platform: 'win32', binary: win, env: {} }).shell, false, '带空格的 exe 直接执行，不经 shell');
});

test('macOS 后台强制 CLI 模式，且不修改调用者的环境', () => {
  const env = { PATH: '/fixture/bin', TAILSCALE_BE_CLI: '0' };
  const options = tailscaleRunOptions({ platform: 'darwin', env });
  assert.equal(options.env.TAILSCALE_BE_CLI, '1');
  assert.equal(env.TAILSCALE_BE_CLI, '0');
  assert.equal(tailscaleRunOptions({ platform: 'win32', binary: 'tailscale.cmd', env }).shell, true);
});

test('手动命令提示保留带空格/引号的路径，平台安装链接均为官方地址', () => {
  assert.equal(tailscaleCommandPrefix("/Users/a'b/Tailscale", 'darwin'), "env TAILSCALE_BE_CLI=1 '/Users/a'\\''b/Tailscale'");
  assert.equal(tailscaleCommandPrefix('C:\\Program Files\\Tailscale\\tailscale.exe', 'win32'), "& 'C:\\Program Files\\Tailscale\\tailscale.exe'");
  for (const [platform, page] of [['darwin', 'mac'], ['linux', 'linux'], ['win32', 'windows']]) {
    assert.ok(tailscaleInstallGuide(platform).includes(`https://tailscale.com/docs/install/${page}`));
  }
});
