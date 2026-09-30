import { memo, useState } from "react";
import { probeRender } from "../utils/renderProbe";
import type { ToolCall } from "../api/types";
import type { FileRef } from "../utils/fileRefs";
import { FileLinkText } from "./FileLinkText";
import { ToolStatusIcon } from "./icons";

const STATUS_TEXT: Record<ToolCall["status"], string> = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
};

/** 工具调用折叠卡片：默认收起显示 name + summary，点击展开 resultPreview；
 * summary/resultPreview 中的文件路径（src/foo.ts:12）识别为可点击 → 打开文件弹层。
 * 渲染性能：React.memo（相邻消息更新时未变化的工具卡不重渲） */
export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  onOpenFile,
}: {
  toolCall: ToolCall;
  onOpenFile?: (ref: FileRef) => void;
}) {
  probeRender("ToolCallCard");
  const [open, setOpen] = useState(false);
  const hasPreview = Boolean(toolCall.resultPreview);

  return (
    <div className="tool-card">
      <div
        className="tool-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => hasPreview && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && hasPreview) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        title={hasPreview ? (open ? "收起结果" : "展开结果") : "无结果预览"}
      >
        <ToolStatusIcon status={toolCall.status} />
        <span className="tool-name">{toolCall.name}</span>
        <span className="tool-summary">
          <FileLinkText text={toolCall.summary || STATUS_TEXT[toolCall.status]} onOpenFile={onOpenFile} />
        </span>
        <span className="hint-text">{STATUS_TEXT[toolCall.status]}</span>
      </div>
      {open && hasPreview && (
        <div className="tool-body">
          <pre>
            <FileLinkText text={toolCall.resultPreview ?? ""} onOpenFile={onOpenFile} />
          </pre>
        </div>
      )}
    </div>
  );
});
