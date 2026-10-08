// autostart 内容生成测试（纯函数；不落盘、不注册真实任务）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildSchtasksCommand,
  buildServicePath,
  escapeXml,
  installAutostart,
} from '../lib/autostart.js';

const REPO = '/repo/agent-hub';
const NODE = '/usr/local/bin/node';

test('escapeXml: 转义 XML 特殊字符', () => {
  assert.equal(escapeXml('a&b<c>"d"\'e\''), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
});

test('buildServicePath: node 同目录前置（nvm 场景服务里找得到 npm/pnpm）', () => {
  const p = buildServicePath('/Users/u/.nvm/versions/node/v22.20.0/bin/node');
  assert.ok(p.startsWith('/Users/u/.nvm/versions/node/v22.20.0/bin:'));
  assert.ok(p.includes('/usr/local/bin') && p.includes('/opt/homebrew/bin'));
  assert.ok(p.endsWith('/usr/bin:/bin:/usr/sbin:/sbin'));
});

test('buildLaunchdPlist: 包含 label / node / start.js / RunAtLoad', () => {
  const xml = buildLaunchdPlist({
    nodePath: NODE,
    scriptPath: path.join(REPO, 'cli', 'start.js'),
    repoRoot: REPO,
    extraArgs: ['--lan'],
    logDir: '/home/u/Library/Logs',
  });
  assert.match(xml, /<string>com\.agent-hub<\/string>/);
  assert.match(xml, new RegExp(`<string>${NODE.replace(/\//g, '\\/')}</string>`));
  assert.match(xml, /cli\/start\.js/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<string>--lan<\/string>/);
  assert.match(xml, /<string>\/home\/u\/Library\/Logs\/agent-hub\.log<\/string>/);
  // PATH 注入：launchd 默认 PATH 不含 nvm/homebrew，缺了 start.js 会「未找到 pnpm / npm」
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
});

test('buildSystemdUnit: 包含 ExecStart / WorkingDirectory / WantedBy', () => {
  const unit = buildSystemdUnit({
    nodePath: NODE,
    scriptPath: path.join(REPO, 'cli', 'start.js'),
    repoRoot: REPO,
    extraArgs: [],
  });
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/repo\/agent-hub\/cli\/start\.js/);
  assert.match(unit, /WorkingDirectory=\/repo\/agent-hub/);
  assert.match(unit, /Environment=PATH=\/usr\/local\/bin:/); // 同 launchd：服务进程 PATH 需含 node 同目录
  assert.match(unit, /WantedBy=default\.target/);
});

test('buildSchtasksCommand: 生成 schtasks 参数数组', () => {
  const args = buildSchtasksCommand({ nodePath: 'C:\\nodejs\\node.exe', scriptPath: 'C:\\hub\\cli\\start.js' });
  assert.equal(args[0], 'schtasks');
  assert.ok(args.includes('/TN') && args.includes('agent-hub'));
  assert.ok(args.includes('/SC') && args.includes('ONLOGON'));
  assert.match(args[args.indexOf('/TR') + 1], /C:\\hub\\cli\\start\.js/);
  assert.match(args[args.indexOf('/TR') + 1], /\\"C:\\nodejs\\node\.exe\\"/);
});

test('installAutostart: dry-run 不落盘且返回内容与命令', () => {
  const res = installAutostart({
    platform: 'darwin',
    home: '/home/u',
    nodePath: NODE,
    repoRoot: REPO,
    dryRun: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.method, 'launchd');
  assert.match(res.detail, /\[dry-run\]/);
  assert.match(res.detail, /com\.agent-hub\.plist/);
  assert.ok(res.commands[0].includes('launchctl load'));
});

test('installAutostart: 执行失败仅提示不抛出', () => {
  const res = installAutostart({
    platform: 'win32',
    home: 'C:\\Users\\u',
    nodePath: 'C:\\nodejs\\node.exe',
    repoRoot: 'C:\\hub',
    dryRun: false,
    run: () => ({ ok: false, status: 1, stdout: '', stderr: 'access denied', error: null }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.method, 'schtasks');
  assert.match(res.detail, /schtasks 注册失败/);
});

test('installAutostart: 未知平台返回 unsupported 不崩溃', () => {
  const res = installAutostart({ platform: 'freebsd', home: '/h', nodePath: NODE, repoRoot: REPO, dryRun: true });
  assert.equal(res.ok, false);
  assert.equal(res.method, 'unsupported');
});
