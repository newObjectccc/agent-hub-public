/**
 * unified diff 查看器：+ 绿 / - 黄红 / 文件头 / 双行号，深浅色适配。
 * 移动友好：13px 等宽 + 横向滚动（不破版，页面本身不出横向滚动条）。
 */
import { useMemo } from "react";
import { countChanges, diffLineClass, parseDiff, type DiffFile } from "../utils/diff";

export function DiffFileBlock({ file }: { file: DiffFile }) {
  return (
    <section className="diff-file">
      <header className="diff-file-head">
        <span className="diff-path" title={file.path}>
          {file.path}
        </span>
        <span className="diff-counts">
          {file.isNew && <span className="git-chip ok">新增</span>}
          {file.isDeleted && <span className="git-chip warn">删除</span>}
          {file.isBinary && <span className="git-chip plain">二进制</span>}
          <span className="diff-add">+{file.additions}</span>
          <span className="diff-del">-{file.deletions}</span>
        </span>
      </header>
      <div className="diff-scroll" role="region" aria-label={`${file.path} 的 diff`}>
        <div className="diff-lines">
          {file.lines.map((line, i) => (
            <div key={i} className={diffLineClass(line.type)}>
              <span className="ln">{line.oldNo ?? ""}</span>
              <span className="ln">{line.newNo ?? ""}</span>
              <span className="lc">
                <span className="sign">{line.prefix === " " ? "" : line.prefix}</span>
                {line.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface DiffViewProps {
  /** unified diff 原文 */
  diff: string;
  /** 无 diff 时的空态文案 */
  emptyText?: string;
}

export function DiffView({ diff, emptyText = "无变更（工作区干净或该文件无 diff）" }: DiffViewProps) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const totals = useMemo(() => countChanges(files), [files]);
  if (files.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <div className="diff-view">
      <div className="diff-summary">
        <span className="git-chip plain">{totals.files} files</span>
        <span className="diff-add">+{totals.additions}</span>
        <span className="diff-del">-{totals.deletions}</span>
      </div>
      {files.map((file, i) => (
        <DiffFileBlock key={`${file.path}-${i}`} file={file} />
      ))}
    </div>
  );
}
