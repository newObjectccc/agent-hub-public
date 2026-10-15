// start 布局判定测试：发包布局（npm pack / npx 安装形态）与源码仓布局的分流——
// 发包布局要跳过 install/build，判错会白跑必败构建或漏跑真实构建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPublishedLayout, depsInstalled } from '../start.js';

const ROOT = path.join(path.sep, 'fake', 'hub');

/** 以「存在路径集合」构造 exists 注入（路径统一走 path.join，跨平台一致）。 */
function existsOf(...relPaths) {
  const set = new Set(relPaths.map((p) => path.join(ROOT, p)));
  return (p) => set.has(p);
}

test('isPublishedLayout: 无 server/web package.json 且产物齐全 → true（发包布局）', () => {
  const exists = existsOf(
    path.join('server', 'dist', 'index.js'),
    path.join('web', 'dist', 'index.html'),
  );
  assert.equal(isPublishedLayout(ROOT, exists), true);
});

test('isPublishedLayout: server/web package.json 在 → false（源码仓布局）', () => {
  // server/package.json 与 web/package.json 任一在都不算发包布局
  const both = existsOf(
    path.join('server', 'package.json'),
    path.join('web', 'package.json'),
    path.join('server', 'dist', 'index.js'),
    path.join('web', 'dist', 'index.html'),
  );
  assert.equal(isPublishedLayout(ROOT, both), false);
  const serverOnly = existsOf(
    path.join('server', 'package.json'),
    path.join('server', 'dist', 'index.js'),
    path.join('web', 'dist', 'index.html'),
  );
  assert.equal(isPublishedLayout(ROOT, serverOnly), false);
  const webOnly = existsOf(
    path.join('web', 'package.json'),
    path.join('server', 'dist', 'index.js'),
    path.join('web', 'dist', 'index.html'),
  );
  assert.equal(isPublishedLayout(ROOT, webOnly), false);
});

test('isPublishedLayout: 产物缺失 → false（判发包布局也不能跳过构建）', () => {
  // server/dist/index.js 缺
  const noServer = existsOf(path.join('web', 'dist', 'index.html'));
  assert.equal(isPublishedLayout(ROOT, noServer), false);
  // web/dist/index.html 缺
  const noWeb = existsOf(path.join('server', 'dist', 'index.js'));
  assert.equal(isPublishedLayout(ROOT, noWeb), false);
  // 两个产物都缺
  const empty = existsOf();
  assert.equal(isPublishedLayout(ROOT, empty), false);
});

test('depsInstalled: 三处 node_modules 齐全才 true（源码仓布局依赖判定不变）', () => {
  const all = existsOf('node_modules', path.join('server', 'node_modules'), path.join('web', 'node_modules'));
  assert.equal(depsInstalled(ROOT, all), true);
  const missingWeb = existsOf('node_modules', path.join('server', 'node_modules'));
  assert.equal(depsInstalled(ROOT, missingWeb), false);
  const none = existsOf();
  assert.equal(depsInstalled(ROOT, none), false);
});
