/**
 * 文件内容弹层：工具调用里点击文件路径打开。纯文本 + 行号（轻量，不引高亮库），
 * 支持跳转到指定行高亮；同文件有 diff 时提供“看 diff”跳转。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { FileContentResult } from "../api/types";
import { Sheet } from "./Sheet";
import { Button } from "./ui/button";

export interface FileViewerProps {
  cwd: string;
  path: string;
  /** 高亮/滚动定位的行号（1 起） */
  line?: number | null;
  /** 该文件是否有未提交 diff（决定是否显示“看 diff”） */
  hasDiff?: boolean;
  onViewDiff?: () => void;
  onClose: () => void;
}

export function FileViewer({ cwd, path, line = null, hasDiff = false, onViewDiff, onClose }: FileViewerProps) {
  const [file, setFile] = useState<FileContentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const targetRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFile(await api.getFileContent(cwd, path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "文件加载失败");
    } finally {
      setLoading(false);
    }
  }, [cwd, path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (file && line) targetRef.current?.scrollIntoView?.({ block: "center" });
  }, [file, line]);

  const lines = file ? file.content.split("\n") : [];

  return (
    <Sheet
      title={path}
      subtitle={file ? `${file.size} 字节${file.truncated ? "（超过 256KB 已截断）" : ""}` : undefined}
      onClose={onClose}
      action={
        hasDiff && onViewDiff ? (
          <Button type="button" variant="outline" size="xs" onClick={onViewDiff}>
            看 diff
          </Button>
        ) : undefined
      }
    >
      {loading && <div className="empty">加载中…</div>}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      {file && (
        <div className="file-code" role="region" aria-label={`${path} 文件内容`}>
          {lines.map((text, i) => {
            const no = i + 1;
            const hit = line !== null && no === line;
            return (
              <div key={no} className={`code-line${hit ? " hit" : ""}`} ref={hit ? targetRef : undefined}>
                <span className="ln">{no}</span>
                <span className="lc">{text === "" ? " " : text}</span>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
