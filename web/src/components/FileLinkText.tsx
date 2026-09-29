/**
 * 文本中的文件路径（src/foo.ts:12）渲染为可点击链接，点击打开文件内容弹层。
 * 无 onOpenFile 或无引用时原样渲染文本，零行为变化。
 */
import type { FileRef } from "../utils/fileRefs";
import { splitFileText } from "../utils/fileRefs";

export interface FileLinkTextProps {
  text: string;
  onOpenFile?: (ref: FileRef) => void;
}

export function FileLinkText({ text, onOpenFile }: FileLinkTextProps) {
  if (!onOpenFile) return <>{text}</>;
  const parts = splitFileText(text);
  if (!parts.some((p) => p.kind === "ref")) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.value}</span>
        ) : (
          <button
            key={i}
            type="button"
            className="file-ref"
            title={`查看文件 ${part.ref.path}`}
            onClick={(e) => {
              // 工具卡片头部可折叠：链接点击不要触发折叠
              e.stopPropagation();
              onOpenFile(part.ref);
            }}
          >
            {part.value}
          </button>
        ),
      )}
    </>
  );
}
