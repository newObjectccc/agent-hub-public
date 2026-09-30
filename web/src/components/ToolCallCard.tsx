import { memo, useState } from "react";
import { probeRender } from "../utils/renderProbe";
import type { ToolCall } from "../api/types";
import { useNowTicker } from "../hooks/useNowTicker";
import type { FileRef } from "../utils/fileRefs";
import { formatElapsed } from "../chat/waitPhase";
import { FileLinkText } from "./FileLinkText";
import { ToolStatusIcon } from "./icons";

const STATUS_TEXT: Record<ToolCall["status"], string> = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
};

/** 工具执行时长：running 实时跳动「⏱ 12s」，结束后「耗时 12s」；无打点不显示 */
function ToolDuration({ toolCall }: { toolCall: ToolCall }) {
  const running = toolCall.status === "running";
  const nowMs = useNowTicker(running);
  const { startedAt, endedAt } = toolCall;
  if (startedAt === undefined) return null;
  const end = running ? nowMs : endedAt ?? startedAt;
  const label = running ? `⏱ ${formatElapsed(end - startedAt)}` : `耗时 ${formatElapsed(end - startedAt)}`;
  return <span className={`tool-duration${running ? " running" : ""}`}>{label}</span>;
}

/** 工具调用折叠卡片：默认收起显示 name + summary，点击展开 resultPreview；
 * summary/resultPreview 中的文件路径（src/foo.ts:12）识别为可点击 → 打开文件弹层；
 * running 卡片带「运行中」脉冲 + 实时时长（reduced-motion 由 CSS 降级静态）。
 * 渲染性能：React.memo（相邻消息更新时未变化的工具卡不重渲）。 */
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
    <div className={`tool-card${toolCall.status === "running" ? " running" : ""}`}>
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
        <ToolDuration toolCall={toolCall} />
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
