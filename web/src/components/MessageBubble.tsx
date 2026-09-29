import { useState } from "react";
import type { SessionMessage } from "../api/types";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

function timeLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 思维链折叠块：野兽派灰底，默认收起，点击展开（流式期间可反复开关） */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-card">
      <div
        className="thinking-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        title={open ? "收起思维过程" : "展开思维过程"}
      >
        <span className="thinking-title">💭 思维过程（{text.length} 字）</span>
        <span className="hint-text">{open ? "收起" : "展开"}</span>
      </div>
      {open && (
        <div className="thinking-body">
          <pre>{text}</pre>
        </div>
      )}
    </div>
  );
}

/** 消息气泡：user 右侧，assistant 左侧（markdown 渲染），思维链折叠块 + toolCalls 折叠卡片 */
export function MessageBubble({ message }: { message: SessionMessage }) {
  const thinking = message.thinking ?? "";
  return (
    <div className={`msg-row ${message.role}`}>
      <div>
        <div className="bubble">
          {message.role === "assistant" ? (
            <>
              {thinking && <ThinkingBlock text={thinking} />}
              {message.text && <Markdown text={message.text} />}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} />
              ))}
              {!message.text && message.toolCalls.length === 0 && !thinking && (
                <span className="hint-text">（无内容）</span>
              )}
            </>
          ) : (
            <>
              {thinking && <ThinkingBlock text={thinking} />}
              <span style={{ whiteSpace: "pre-wrap" }}>{message.text}</span>
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} />
              ))}
            </>
          )}
        </div>
        <div className="msg-time">{timeLabel(message.timestamp)}</div>
      </div>
    </div>
  );
}
