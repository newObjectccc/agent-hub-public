import type { SessionMessage } from "../api/types";
import type { FileRef } from "../utils/fileRefs";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

function timeLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 消息气泡：user 右侧，assistant 左侧（markdown 渲染），toolCalls 为折叠卡片。
 *  highlight=true 时高亮（搜索定位 ?q= 跳转命中消息）；onOpenFile 点击文件引用打开弹层。 */
export function MessageBubble({
  message,
  highlight,
  onOpenFile,
}: {
  message: SessionMessage;
  highlight?: boolean;
  onOpenFile?: (ref: FileRef) => void;
}) {
  return (
    <div id={`msg-${message.id}`} className={`msg-row ${message.role}${highlight ? " search-hit" : ""}`}>
      <div>
        <div className="bubble">
          {message.role === "assistant" ? (
            <>
              {message.text && <Markdown text={message.text} />}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} onOpenFile={onOpenFile} />
              ))}
              {!message.text && message.toolCalls.length === 0 && (
                <span className="hint-text">（无内容）</span>
              )}
            </>
          ) : (
            <>
              <span style={{ whiteSpace: "pre-wrap" }}>{message.text}</span>
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} onOpenFile={onOpenFile} />
              ))}
            </>
          )}
        </div>
        <div className="msg-time">{timeLabel(message.timestamp)}</div>
      </div>
    </div>
  );
}
