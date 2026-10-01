// pi 扩展安装：把 integrations/ 下的单文件自包含扩展拷贝到 ~/.pi/agent/extensions/。
// 纯 Node 零依赖；拷贝为「内容一致才跳过」的幂等操作，不覆盖用户已手动魔改的同名文件以外的内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 扩展清单：源文件（相对仓库根）→ 目标文件名（~/.pi/agent/extensions/ 下）。
 * 与各扩展源码头部注释的安装说明一致（live-feed.ts / pi-command.ts）。
 */
export const EXTENSIONS = [
  {
    id: 'live-feed',
    source: path.join('integrations', 'pi-live-feed', 'live-feed.ts'),
    target: 'live-feed.ts',
    label: 'live-feed（实时旁观事件流推送）',
  },
  {
    id: 'pi-command',
    source: path.join('integrations', 'pi-command', 'command.ts'),
    target: 'pi-command.ts',
    label: 'pi-command（反向指令接收 / 双模式会话驱动）',
  },
];

/** 默认扩展安装目录：~/.pi/agent/extensions（home 可注入，便于测试）。 */
export function extensionsDir(home = os.homedir()) {
  return path.join(home, '.pi', 'agent', 'extensions');
}

/**
 * 安装全部扩展（幂等）：
 * - 源文件缺失 → skipped（记录原因），不算失败（可能来自裁剪后的发行包）
 * - 目标已存在且内容一致 → unchanged（跳过写盘）
 * - 目标已存在但内容不同 → overwritten（更新为仓库版本；扩展以仓库为准）
 * - 目标不存在 → installed
 * 任一异常被捕获为该项 failed，不抛出，不影响其余项。
 *
 * @returns {{ok: boolean, dir: string, results: Array<{id: string, label: string, status: string, target: string, error?: string}>}}
 */
export function installExtensions({ root, home = os.homedir(), dir, dryRun = false, copy = fs.copyFileSync, exists = fs.existsSync, read = fs.readFileSync, mkdir = fs.mkdirSync } = {}) {
  const targetDir = dir ?? extensionsDir(home);
  const results = [];
  for (const ext of EXTENSIONS) {
    const src = path.join(root, ext.source);
    const dst = path.join(targetDir, ext.target);
    try {
      if (!exists(src)) {
        results.push({ id: ext.id, label: ext.label, status: 'skipped', target: dst, error: `源文件不存在: ${src}` });
        continue;
      }
      let status = 'installed';
      if (exists(dst)) {
        const same = Buffer.compare(read(src), read(dst)) === 0;
        status = same ? 'unchanged' : 'overwritten';
      }
      if (!dryRun && status !== 'unchanged') {
        mkdir(targetDir, { recursive: true });
        copy(src, dst);
      }
      results.push({ id: ext.id, label: ext.label, status, target: dst });
    } catch (e) {
      results.push({ id: ext.id, label: ext.label, status: 'failed', target: dst, error: String(e?.message ?? e) });
    }
  }
  return { ok: results.every((r) => r.status !== 'failed'), dir: targetDir, results };
}
