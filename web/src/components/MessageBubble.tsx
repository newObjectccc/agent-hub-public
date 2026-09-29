import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMessage } from "../api/types";
import { copyText } from "../utils/clipboard";
import { LongPressDetector } from "../utils/longPress";
import { showToast } from "../utils/toast";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

function timeLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const COPY_SUCCESS_TOAST = "已复制消息文本";
export const COPY_FAIL_TOAST = "复制失败，请手动选择文本";

/**
 * 消息气泡：user 右侧，assistant 左侧（markdown 渲染），toolCalls 为折叠卡片。
 * 长按气泡 → 复制菜单（触屏 long-press；桌面右键同入口），复制成功出 toast。
 */
export function MessageBubble({ message }: { message: SessionMessage }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const suppressClickRef = useRef(false);
  const hasText = message.text.trim() !== "";

  // 长按识别：纯状态机（定时器默认实现；单测直接测 LongPressDetector）
  const detector = useMemo(
    () => new LongPressDetector(() => setMenuOpen(true)),
    [],
  );
  useEffect(() => () => detector.cancel(), [detector]);

  const handleCopy = async () => {
    setMenuOpen(false);
    const ok = await copyText(message.text);
    showToast(ok ? COPY_SUCCESS_TOAST : COPY_FAIL_TOAST);
  };

  return (
    <div className={`msg-row ${message.role}`}>
      <div
        className="msg-body"
        onPointerDown={(e) => {
          if (!hasText || menuOpen) return;
          detector.start(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => detector.move(e.clientX, e.clientY)}
        onPointerUp={() => {
          if (detector.end()) suppressClickRef.current = true;
        }}
        onPointerCancel={() => detector.cancel()}
        onContextMenu={(e) => {
          if (!hasText) return;
          // 抑制系统长按/右键菜单，走自带复制菜单
          e.preventDefault();
          detector.cancel();
          setMenuOpen(true);
        }}
        onClickCapture={(e) => {
          // 长按触发后的误触 click（如工具卡展开）抑制一次
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div className="bubble">
          {message.role === "assistant" ? (
            <>
              {message.text && <Markdown text={message.text} />}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} />
              ))}
              {!message.text && message.toolCalls.length === 0 && <span className="hint-text">（无内容）</span>}
            </>
          ) : (
            <>
              <span style={{ whiteSpace: "pre-wrap" }}>{message.text}</span>
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} />
              ))}
            </>
          )}
        </div>
        <div className="msg-time">{timeLabel(message.timestamp)}</div>

        {menuOpen && (
          <>
            <div className="msg-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <div className="msg-menu" role="menu" aria-label="消息操作">
              <button type="button" role="menuitem" className="msg-menu-item" onClick={() => void handleCopy()}>
                复制文本
              </button>
              <button type="button" role="menuitem" className="msg-menu-item" onClick={() => setMenuOpen(false)}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
