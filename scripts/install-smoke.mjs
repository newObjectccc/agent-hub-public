#!/usr/bin/env node
/** 真实 npm 全局安装/换安装目录/首次 remote 冒烟；只用自有 HOME，不读个人会话或凭据。
 * Tailscale 是受控 CLI：验证装配和参数，不修改本机 Serve，不冒充跨设备验收。
 * 先 build；node scripts/install-smoke.mjs [--tarball path] [--output report.json] [--keep]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findCommand } from '../cli/lib/process.js';

const run = promisify(execFile), args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); if (i < 0) return undefined; assert(args[i + 1] && !args[i + 1].startsWith('--'), `${flag} 缺少路径`); return resolve(args[i + 1]); };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locatedNpm = findCommand('npm').path;
assert(locatedNpm, '需要 npm');
const actualNpm = await realpath(locatedNpm);
const npmCli = [actualNpm, join(dirname(locatedNpm), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(locatedNpm), '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(p => basename(p) === 'npm-cli.js' && existsSync(p));
assert(npmCli, '未找到 npm-cli.js；请使用官方 Node/npm 安装');
const npm = (argv, options = {}) => run(process.execPath, [npmCli, ...argv], { timeout: 300_000, maxBuffer: 4_000_000, ...options });
const owned = await mkdtemp(join(tmpdir(), 'agent-hub-install-owned-')); await chmod(owned, 0o700);
const home = join(owned, 'home'), bins = join(owned, 'bin'), npmrc = join(owned, 'empty-npmrc'), globalNpmrc = join(owned, 'empty-global-npmrc');
await mkdir(home); await mkdir(bins); await writeFile(npmrc, ''); await writeFile(globalNpmrc, '');
const report = { scope: '本机隔离 HOME 的真实 npm 安装；Tailscale CLI 受控，未验证跨设备访问或真实模型调用', checks: [] };
let child;
const check = (name, condition) => { assert(condition, name); report.checks.push(name); };
const pause = ms => new Promise(done => setTimeout(done, ms));
const stop = async () => {
  if (!child) return;
  const previous = child; child = undefined;
  if (previous.exitCode !== null || previous.signalCode !== null) return;
  previous.kill('SIGTERM');
  for (let i = 0; i < 70 && previous.exitCode === null && previous.signalCode === null; i++) await pause(100);
  if (previous.exitCode === null && previous.signalCode === null) { previous.kill('SIGKILL'); throw Error('CLI 未按时关闭自身 server'); }
};
try {
  const metadata = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  let tarball = value('--tarball');
  if (!tarball) {
    const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', owned], { cwd: repo })).stdout);
    tarball = join(owned, packed[0].filename);
  }
  report.package = metadata.name; report.version = metadata.version;
  report.integrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (process.platform === 'win32') await copyFile(process.execPath, join(bins, nodeName));
  else await symlink(process.execPath, join(bins, nodeName));
  const tailLog = join(owned, 'tailscale-arguments.jsonl');
  const fake = join(bins, 'tailscale.mjs');
  await writeFile(fake, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(tailLog)},JSON.stringify(a)+'\\n');
if(a[0]==='version')console.log('1.80.0');
else if(a[0]==='status')console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'smoke.example.ts.net.'}}));
else if(a[0]==='debug')console.log(JSON.stringify({ControlURL:'https://controlplane.tailscale.com'}));
else if(a[0]==='serve')console.log('Controlled Serve fixture');
else process.exitCode=1;
`);
  if (process.platform === 'win32') await writeFile(join(bins, 'tailscale.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else { await chmod(fake, 0o755); await symlink(fake, join(bins, 'tailscale')); }
  const system = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  const env = {
    PATH: [bins, ...system].join(delimiter), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    LANG: 'C.UTF-8', CI: 'true', CODEX_HOME: join(home, '.codex'),
    TMPDIR: owned, TEMP: owned, TMP: owned,
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    npm_config_cache: join(owned, 'npm-cache'), npm_config_update_notifier: 'false',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
  };
  const workspace = join(home, 'Workspace'); await mkdir(workspace);
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const base = `http://127.0.0.1:${port}`;
  const configPath = join(home, '.agent-hub/config/hub.config.json');
  const installed = async name => {
    const prefix = join(owned, name);
    await npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { cwd: owned, env });
    const root = (await npm(['root', '--global', '--prefix', prefix], { cwd: owned, env })).stdout.trim();
    check(`${name} 已注册 agent-hub 命令`, existsSync(process.platform === 'win32' ? join(prefix, 'agent-hub.cmd') : join(prefix, 'bin/agent-hub')));
    return join(root, ...metadata.name.split('/'));
  };
  const first = await installed('install-a');
  const version = (await run(process.execPath, [join(first, 'cli/cli.js'), '--version'], { env })).stdout.trim();
  report.cliVersion = version;
  check('真实 npm 安装后的 CLI 版本正确', version === `agent-hub v${metadata.version}`);
  const setup = await run(process.execPath, [join(first, 'cli/cli.js'), 'setup', '--no-extensions', '--port', String(port), '--workspace-root', workspace, '--no-color'], { env, timeout: 30_000, maxBuffer: 1_000_000 });
  check('无 pnpm/全局 pi 的首次 setup 不递归安装或构建', !setup.stdout.includes('使用 npm install') && !setup.stdout.includes('使用 pnpm install'));
  const initialConfig = await readFile(configPath, 'utf8');
  check('配置写入用户目录并保留所选项目根', JSON.parse(initialConfig).workspaceRoot === workspace && !existsSync(join(first, 'config/hub.config.json')));
  const beforeDryRun = existsSync(tailLog) ? await readFile(tailLog, 'utf8') : '';
  await run(process.execPath, [join(first, 'cli/cli.js'), 'remote', '--dry-run', '--no-color'], { env, timeout: 30_000 });
  check('remote dry-run 不修改 Serve 或用户配置', (existsSync(tailLog) ? await readFile(tailLog, 'utf8') : '') === beforeDryRun && await readFile(configPath, 'utf8') === initialConfig);
  let output = '';
  const start = async root => {
    output = '';
    child = spawn(process.execPath, [join(root, 'cli/cli.js'), 'remote', '--no-color'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-100_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-100_000); });
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('已安装包 remote 提前退出：' + output.slice(-1500));
      try { const r = await fetch(base + '/api/app-lock/status', { signal: AbortSignal.timeout(500) }); if (r.ok) return; } catch { /* 仅等待自有端口 */ }
      await pause(100);
    }
    throw Error('已安装包未启动：' + output.slice(-1500));
  };
  await start(first);
  const page = await fetch(base), html = await page.text();
  check('已安装产物的首页可访问', page.status === 200 && html.includes('<html'));
  const asset = html.match(/src="([^"]+\/assets\/[^"]+\.js|\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset, '首页缺少入口脚本');
  const bundle = await fetch(new URL(asset, base));
  check('首页实际引用的脚本可加载且不是 SPA 回退页', bundle.status === 200 && /javascript/.test(bundle.headers.get('content-type') ?? ''));
  const manifest = await fetch(base + '/manifest.json');
  const manifestJson = await manifest.json();
  check('PWA manifest 可加载且为独立窗口模式', manifest.ok && manifestJson.display === 'standalone');
  check('PWA 声明 192 与 512 图标', ['192x192','512x512'].every(size => manifestJson.icons?.some(icon => icon.sizes.split(' ').includes(size))));
  for (const icon of manifestJson.icons ?? []) {
    const image = await fetch(new URL(icon.src, base));
    check(`PWA 图标 ${icon.sizes} 可加载`, image.ok && (image.headers.get('content-type') ?? '').startsWith('image/'));
  }
  const worker = await fetch(base + '/sw.js');
  check('PWA service worker 可加载', worker.ok && /javascript/.test(worker.headers.get('content-type') ?? ''));
  const sessions = await fetch(base + '/api/sessions');
  const sessionList = await sessions.json();
  check('首次空会话 API 正常且没有继承个人历史', sessions.ok && Array.isArray(sessionList) && sessionList.length === 0);
  const requireInstalled = createRequire(join(first, 'package.json'));
  const { WebSocket } = requireInstalled('ws');
  await new Promise((done, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/events');
    const timer = setTimeout(() => { ws.terminate(); reject(Error('WS 连接超时')); }, 5000);
    ws.once('error', e => { clearTimeout(timer); reject(e); });
    ws.once('open', () => { clearTimeout(timer); ws.close(); done(); });
  });
  check('已安装包 WebSocket 可建立连接', true);
  const configured = await fetch(base + '/api/app-lock/setup', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ secret: '367892' }) });
  check('自有测试用户可设置应用锁', configured.status === 201);
  const tailCalls = (await readFile(tailLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  check('remote 正确装配 tailnet HTTPS Serve 参数', tailCalls.some(a => JSON.stringify(a) === JSON.stringify(['serve', '--bg', '--https=443', base])));
  check('包安装后 remote 不要求现场构建', !output.includes('vite build') && !output.includes('tsc）'));
  await stop();
  const second = await installed('install-b');
  await run(process.execPath, [join(second, 'cli/cli.js'), 'setup', '--no-extensions', '--no-color'], { env, timeout: 30_000 });
  check('换全新安装目录后用户配置不丢失', await readFile(configPath, 'utf8') === initialConfig);
  await start(second);
  const restored = await fetch(base + '/api/app-lock/status');
  check('换安装目录后应用锁仍然配置', restored.ok && (await restored.json()).configured === true);
  await stop();
  report.ok = true;
  if (args.includes('--keep')) report.fixture = { owned, home, installedRoot: second, port };
} catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.ok = false; report.cleanupError = error.message; process.exitCode = 1; }
  const destination = value('--output');
  if (destination) { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
  if (!args.includes('--keep')) await rm(owned, { recursive: true, force: true });
}
