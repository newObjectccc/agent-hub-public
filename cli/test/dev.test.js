// dev.js 纯逻辑测试：行前缀流（逐行加 [tag] 前缀、跨 chunk 半行缓存、flush 兜底、空行透传）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLineStream } from '../dev.js';

test('整行输出加 [tag] 前缀', () => {
  const out = [];
  const s = createLineStream('web', (line) => out.push(line));
  s.push('hello\nworld\n');
  assert.deepEqual(out, ['[web] hello', '[web] world']);
});

test('跨 chunk 的半行先缓存，拼上下一段再输出', () => {
  const out = [];
  const s = createLineStream('server', (line) => out.push(line));
  s.push('par');
  assert.deepEqual(out, []);
  s.push('tial\nnext\n');
  assert.deepEqual(out, ['[server] partial', '[server] next']);
});

test('flush 吐出残留半行', () => {
  const out = [];
  const s = createLineStream('tsc', (line) => out.push(line));
  s.push('no-newline');
  assert.deepEqual(out, []);
  s.flush();
  assert.deepEqual(out, ['[tsc] no-newline']);
  s.flush(); // 幂等：再次 flush 无输出
  assert.deepEqual(out, ['[tsc] no-newline']);
});

test('空行透传不加前缀', () => {
  const out = [];
  const s = createLineStream('web', (line) => out.push(line));
  s.push('a\n\nb\n');
  assert.deepEqual(out, ['[web] a', '', '[web] b']);
});

test('\\r\\n 换行同样按行切分', () => {
  const out = [];
  const s = createLineStream('web', (line) => out.push(line));
  s.push('win\r\nlines\r\n');
  assert.deepEqual(out, ['[web] win', '[web] lines']);
});
