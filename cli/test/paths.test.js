// `~` 展开与路径拼接测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  expandHome,
  normalizeSeparators,
  resolvePath,
  defaultConfigPath,
  repoRoot,
} from '../lib/paths.js';

const HOME = '/home/tester';
const WIN_HOME = 'C:\\Users\\tester';

test('expandHome: 裸 ~ 展开为主目录', () => {
  assert.equal(expandHome('~', HOME), HOME);
  assert.equal(expandHome('~', WIN_HOME, '\\'), WIN_HOME);
});

test('expandHome: ~/ 与 ~\\ 前缀展开并正确拼接', () => {
  assert.equal(expandHome('~/a/b', HOME, '/'), '/home/tester/a/b');
  assert.equal(expandHome('~\\a\\b', HOME, '/'), '/home/tester/a/b');
  // Windows 主目录 + POSIX 风格输入 → 统一到 Windows 分隔符
  assert.equal(expandHome('~/.pi/agent/sessions', WIN_HOME, '\\'), 'C:\\Users\\tester\\.pi\\agent\\sessions');
  assert.equal(expandHome('~\\.pi\\agent', WIN_HOME, '\\'), 'C:\\Users\\tester\\.pi\\agent');
  // 混合分隔符归一
  assert.equal(expandHome('~/a\\b/c', HOME, '/'), '/home/tester/a/b/c');
});

test('expandHome: ~user 不展开、绝对/相对路径原样返回', () => {
  assert.equal(expandHome('~user/x', HOME), '~user/x');
  assert.equal(expandHome('/abs/path', HOME), '/abs/path');
  assert.equal(expandHome('rel/path', HOME), 'rel/path');
});

test('expandHome: 空值与非字符串原样返回', () => {
  assert.equal(expandHome('', HOME), '');
  assert.equal(expandHome(undefined, HOME), undefined);
  assert.equal(expandHome(null, HOME), null);
});

test('normalizeSeparators: 分隔符统一到平台', () => {
  assert.equal(normalizeSeparators('a/b\\c', '/'), 'a/b/c');
  assert.equal(normalizeSeparators('a/b\\c', '\\'), 'a\\b\\c');
});

test('resolvePath: ~ 先展开再 resolve', () => {
  assert.equal(
    resolvePath('~/x', { home: HOME, base: '/tmp/base' }),
    path.resolve('/tmp/base', '/home/tester/x'),
  );
  assert.equal(resolvePath('rel', { home: HOME, base: '/tmp/base' }), path.resolve('/tmp/base', 'rel'));
});

test('defaultConfigPath / repoRoot 指向仓库结构', () => {
  assert.equal(defaultConfigPath('/repo'), path.join('/repo', 'config', 'hub.config.json'));
  assert.equal(typeof repoRoot(), 'string');
  assert.ok(repoRoot().length > 0);
});
