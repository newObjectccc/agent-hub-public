import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMessage } from "../api/types";
import { copyText } from "../utils/clipboard";
import type { FileRef } from "../utils/fileRefs";
import { LongPressDetector } from "../utils/longPress";
import { showToast } from "../utils/toast";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const COPY_SUCCESS_TOAST = "已复制消息文本";
export const COPY_FAIL_TOAST = "复制失败，请手动选择文本";

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

/** 流式进行中空回合的活占位：打字点点点（reduced-motion 降级静态文案，CSS 控制） */
function StreamingPlaceholder() {
  return (
    <span className="streaming-placeholder" role="status">
      <span className="streaming-placeholder-text">✍️ 回复中</span>
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/**
 * 消息气泡：user 右侧，assistant 左侧（markdown 渲染），思维链折叠块 + toolCalls 折叠卡片。
 * highlight=true 时高亮（搜索定位 ?q= 跳转命中消息）；onOpenFile 点击文件引用打开弹层。
 * 长按气泡 → 操作菜单（复制文本 / 引用；触屏 long-press；桌面右键同入口）；
 * 图片例外：不拦截长按/右键，让 Android Chrome 原生"保存图片"菜单工作。
 * streaming 消息（message_start → message_end）：空内容显示"✍️ 回复中…"活占位（绝不显示"（无内容）"），
 * 气泡带进行中微光；同会话并行回合（sub agent 并行）带 🔗 序号标记。
 */
export function MessageBubble({
  message,
  highlight,
  onOpenFile,
  onQuote,
  liveIndex,
  liveTotal,
}: {
  message: SessionMessage;
  highlight?: boolean;
  onOpenFile?: (ref: FileRef) => void;
  /** 长按菜单"引用"：把消息文本送入输入框引用条 */
  onQuote?: (message: SessionMessage) => void;
  /** 同会话并行流式回合序号（1 起）/ 总数：>1 时显示 🔗 标记 */
  liveIndex?: number;
  liveTotal?: number;
}) {
  const thinking = message.thinking ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const suppressClickRef = useRef(false);
  const hasText = message.text.trim() !== "";
  const images = message.images ?? [];
  const streaming = message.streaming === true;
  const empty = message.text === "" && message.toolCalls.length === 0 && !thinking && images.length === 0;
  /** 引用消息以 Markdown 引用块开头（`> `），用 markdown 渲染让两端 agent 口径一致 */
  const isQuoted = /^>\s?/.test(message.text);

  // 图片目标不进入长按状态机（交还系统菜单）
  const isImageTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.tagName === "IMG";

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

  const handleQuote = () => {
    setMenuOpen(false);
    onQuote?.(message);
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={`msg-row ${message.role}${highlight ? " search-hit" : ""}${streaming ? " streaming" : ""}`}
    >
      <div
        className="msg-body"
        onPointerDown={(e) => {
          if (!hasText || menuOpen || isImageTarget(e.target)) return;
          detector.start(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => detector.move(e.clientX, e.clientY)}
        onPointerUp={() => {
          if (detector.end()) suppressClickRef.current = true;
        }}
        onPointerCancel={() => detector.cancel()}
        onContextMenu={(e) => {
          // 图片：不拦截，交给系统长按菜单（Android Chrome “保存图片”）
          if (isImageTarget(e.target)) return;
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
              {(streaming || liveTotal !== undefined && liveTotal > 1) && (
                <div className="msg-live-row">
                  {streaming && <span className="live-tag">⚡ 进行中</span>}
                  {liveTotal !== undefined && liveTotal > 1 && liveIndex !== undefined && (
                    <span className="live-parallel" title="同会话并行回合（子代理并行）">
                      🔗 回合 {liveIndex}
                    </span>
                  )}
                </div>
              )}
              {thinking && <ThinkingBlock text={thinking} />}
              {message.text && <Markdown text={message.text} />}
              {images.length > 0 && (
                <div className="msg-images">
                  {images.map((img, i) => (
                    <img key={`${message.id}-img-${i}`} className="msg-img" src={img.url} alt={img.alt ?? "图片"} loading="lazy" />
                  ))}
                </div>
              )}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} onOpenFile={onOpenFile} />
              ))}
              {empty && streaming && <StreamingPlaceholder />}
              {empty && !streaming && <span className="hint-text">（无内容）</span>}
            </>
          ) : (
            <>
              {thinking && <ThinkingBlock text={thinking} />}
              {isQuoted ? (
                <Markdown text={message.text} />
              ) : (
                <span style={{ whiteSpace: "pre-wrap" }}>{message.text}</span>
              )}
              {images.length > 0 && (
                <div className="msg-images">
                  {images.map((img, i) => (
                    <img key={`${message.id}-img-${i}`} className="msg-img" src={img.url} alt={img.alt ?? "图片"} loading="lazy" />
                  ))}
                </div>
              )}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} onOpenFile={onOpenFile} />
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
              {onQuote && (
                <button type="button" role="menuitem" className="msg-menu-item" onClick={handleQuote}>
                  引用
                </button>
              )}
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
