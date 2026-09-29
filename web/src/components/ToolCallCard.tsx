import { useState } from "react";
import type { ToolCall } from "../api/types";
import { ToolStatusIcon } from "./icons";

const STATUS_TEXT: Record<ToolCall["status"], string> = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
};

/** 工具调用折叠卡片：默认收起显示 name + summary，点击展开 resultPreview */
export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
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
        <span className="tool-summary">{toolCall.summary || STATUS_TEXT[toolCall.status]}</span>
        <span className="hint-text">{STATUS_TEXT[toolCall.status]}</span>
      </div>
      {open && hasPreview && (
        <div className="tool-body">
          <pre>{toolCall.resultPreview}</pre>
        </div>
      )}
    </div>
  );
}
