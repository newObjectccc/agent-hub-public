// pi 扩展安装逻辑测试（临时目录 + 注入 fs，断言幂等与容错）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSIONS, extensionsDir, installExtensions } from '../lib/extensions.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个含全部扩展源文件的假仓库根。 */
function fakeRoot(dir) {
  for (const ext of EXTENSIONS) {
    const src = path.join(dir, ext.source);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, `// fake ${ext.id}\n`, 'utf8');
  }
  return dir;
}

test('extensionsDir: 默认 ~/.pi/agent/extensions，home 可注入', () => {
  assert.equal(extensionsDir('/home/x'), path.join('/home/x', '.pi', 'agent', 'extensions'));
});

test('installExtensions: 首次安装 → installed，文件内容与源一致', (t) => {
  const root = fakeRoot(tmpDir(t));
  const dir = path.join(tmpDir(t), 'extensions');
  const res = installExtensions({ root, dir });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, EXTENSIONS.length);
  for (const ext of EXTENSIONS) {
    const r = res.results.find((x) => x.id === ext.id);
    assert.equal(r.status, 'installed');
    assert.equal(fs.readFileSync(path.join(dir, ext.target), 'utf8'), `// fake ${ext.id}\n`);
  }
});

test('installExtensions: 幂等——重复执行为 unchanged 且不重写', (t) => {
  const root = fakeRoot(tmpDir(t));
  const dir = path.join(tmpDir(t), 'extensions');
  installExtensions({ root, dir });
  let copied = 0;
  const res = installExtensions({ root, dir, copy: () => { copied += 1; } });
  assert.equal(res.ok, true);
  assert.equal(copied, 0);
  assert.ok(res.results.every((r) => r.status === 'unchanged'));
});

test('installExtensions: 目标被改动 → overwritten 覆盖为仓库版本', (t) => {
  const root = fakeRoot(tmpDir(t));
  const dir = path.join(tmpDir(t), 'extensions');
  installExtensions({ root, dir });
  fs.writeFileSync(path.join(dir, 'live-feed.ts'), '// user edited\n', 'utf8');
  const res = installExtensions({ root, dir });
  assert.equal(res.results.find((r) => r.id === 'live-feed').status, 'overwritten');
  assert.equal(fs.readFileSync(path.join(dir, 'live-feed.ts'), 'utf8'), '// fake live-feed\n');
});

test('installExtensions: 源缺失 → skipped 不算失败', (t) => {
  const root = tmpDir(t);
  const dir = path.join(tmpDir(t), 'extensions');
  const res = installExtensions({ root, dir });
  assert.equal(res.ok, true);
  assert.ok(res.results.every((r) => r.status === 'skipped'));
});

test('installExtensions: dry-run 不写盘', (t) => {
  const root = fakeRoot(tmpDir(t));
  const dir = path.join(tmpDir(t), 'extensions');
  const res = installExtensions({ root, dir, dryRun: true });
  assert.equal(res.ok, true);
  assert.ok(res.results.every((r) => r.status === 'installed'));
  assert.equal(fs.existsSync(dir), false);
});

test('installExtensions: 单项写盘异常 → failed，其余项照常', (t) => {
  const root = fakeRoot(tmpDir(t));
  const dir = path.join(tmpDir(t), 'extensions');
  const res = installExtensions({
    root,
    dir,
    copy: (src, dst) => {
      if (dst.endsWith('pi-command.ts')) throw new Error('disk full');
      fs.copyFileSync(src, dst);
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.results.find((r) => r.id === 'pi-command').status, 'failed');
  assert.match(res.results.find((r) => r.id === 'pi-command').error, /disk full/);
  assert.equal(res.results.find((r) => r.id === 'live-feed').status, 'installed');
});
