/**
 * 直接执行判定单测：npm bin/npx 经 symlink 调用时必须仍判为直接执行（realpath 归一化）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectRun } from '../lib/entry.js';

test('isDirectRun: 直接路径命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'));
  const file = join(dir, 'cli.js');
  writeFileSync(file, '// stub\n');
  try {
    assert.equal(isDirectRun(pathToFileURL(realpathSync(file)).href, file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectRun: symlink 路径也命中（npm bin 场景，regression）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'));
  const file = join(dir, 'cli.js');
  const link = join(dir, 'agent-hub');
  writeFileSync(file, '// stub\n');
  symlinkSync(file, link);
  try {
    // metaUrl 是 realpath；target 传 symlink 路径（argv[1] 的真实形态）
    assert.equal(isDirectRun(pathToFileURL(realpathSync(file)).href, link), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectRun: 非入口路径不命中；无 target 不命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'));
  const a = join(dir, 'a.js');
  const b = join(dir, 'b.js');
  writeFileSync(a, '// a\n');
  writeFileSync(b, '// b\n');
  try {
    assert.equal(isDirectRun(pathToFileURL(a).href, b), false);
    assert.equal(isDirectRun(pathToFileURL(a).href, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
