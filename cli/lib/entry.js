/**
 * 直接执行判定：npm bin / npx 通过 symlink 调用时，process.argv[1] 是链接路径，
 * 而 import.meta.url 是 realpath——直接比较恒 false（入口静默退出）。
 * 这里把 target 归一化到 realpath 后再比。target 可注入以便测试。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDirectRun(metaUrl, target = process.argv[1]) {
  if (!target) return false;
  const href = (p) => pathToFileURL(p).href;
  try {
    return metaUrl === href(realpathSync(target));
  } catch {
    return metaUrl === href(target);
  }
}
