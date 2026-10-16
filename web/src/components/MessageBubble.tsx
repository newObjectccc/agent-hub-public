import { memo, useEffect, useMemo, useRef, useState } from "react";
import { probeRender } from "../utils/renderProbe";
import type { MessageError, SessionMessage } from "../api/types";
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

/**
 * 消息图片：懒加载 + 16:10 占位防跳动；load 后标 .img-loaded、error 后标 .img-error
 * 恢复布局（不永留占位）；缓存命中不再来事件 → ref 兜底按 naturalWidth 判定。
 */
function MsgImage({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      className="msg-img"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      ref={(el) => {
        if (el && el.complete) el.classList.add(el.naturalWidth > 0 ? "img-loaded" : "img-error");
      }}
      onLoad={(e) => e.currentTarget.classList.add("img-loaded")}
      onError={(e) => e.currentTarget.classList.add("img-error")}
    />
  );
}

/** 思维链折叠块：野兽派灰底，默认收起，点击展开（流式期间可反复开关） */
const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
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
});

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
 *
 * 渲染性能：React.memo（message 引用未变的历史消息不随相邻消息更新重渲）；
 * measureRef 供长会话窗口化测量行高（传入方须保持引用稳定，否则 memo 失效）。
 */
/**
 * 错误条文案（纯函数，可单测）：把 server 透出的 stopReason/errorMessage 变成可行动的中文。
 *
 * 修复前：pi 的余额耗尽 / Connection error / 上下文溢出都不抛异常，只落在 assistant 消息的
 * stopReason+errorMessage 上，而 DTO 不取这两个字段 → 手机只看到一个灰色「（无内容）」气泡，
 * 零原因零出路（实测语料里就有 "You have no credits remaining…"）。
 */
export function describeMessageError(
  error: MessageError | undefined,
): { text: string; tone: "error" | "muted"; canCompact: boolean } | null {
  if (!error) return null;
  if (error.kind === "aborted") {
    return { text: error.message || "本轮已中止", tone: "muted", canCompact: false };
  }
  if (error.kind === "contextOverflow") {
    // 可自救：给出具体动作而不是只报失败（手机继续老的大会话最容易撞上这个）
    return {
      text: `上下文已满，这轮没能发出去。压缩上下文后可继续（历史会被摘要，会话不丢）。原始错误：${error.message}`,
      tone: "error",
      canCompact: true,
    };
  }
  return { text: `模型/网络错误：${error.message}`, tone: "error", canCompact: false };
}

export const MessageBubble = memo(function MessageBubble({
  message,
  highlight,
  onOpenFile,
  onQuote,
  liveIndex,
  liveTotal,
  sendFailed,
  sendQueued,
  onRetry,
  onCompact,
  measureRef,
}: {
  message: SessionMessage;
  highlight?: boolean;
  onOpenFile?: (ref: FileRef) => void;
  /** 长按菜单"引用"：把消息文本送入输入框引用条 */
  onQuote?: (message: SessionMessage) => void;
  /** 同会话并行流式回合序号（1 起）/ 总数：>1 时显示 🔗 标记 */
  liveIndex?: number;
  liveTotal?: number;
  /** 发送失败标记（网络错误/5xx/未接受）：显示"⚠️ 发送失败" + 重试按钮 */
  sendFailed?: boolean;
  /** 进阶：已入离线队列等网络恢复自动重发（在失败条上追加「📶 等待发送」标记） */
  sendQueued?: boolean;
  /** 点击"重试"：重发同样内容 */
  onRetry?: () => void;
  /** 上下文溢出时的一键自救：压缩上下文（仅 kind=contextOverflow 的错误条出现） */
  onCompact?: () => void;
  /** 行高测量 ref（长会话窗口化；引用须稳定） */
  measureRef?: (el: HTMLDivElement | null) => void;
}) {
  probeRender("MessageBubble");
  const thinking = message.thinking ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const suppressClickRef = useRef(false);
  const hasText = message.text.trim() !== "";
  const images = message.images ?? [];
  const streaming = message.streaming === true;
  const empty = message.text === "" && message.toolCalls.length === 0 && !thinking && images.length === 0;
  // 错误条（仅 assistant：server 只对 assistant 消息提取 stopReason）
  const errorInfo = message.role === "assistant" ? describeMessageError(message.error) : null;
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

  // 菜单开着时"点击/触摸空白处关闭"：backdrop 不拦截 hit-test（见 styles.css 注释，
  // fixed 层会把触摸拖动的滚动目标变成 window，消息区拖不动），改由 document 捕获监听；
  // 首次点击只关菜单不落到下方内容（与旧 backdrop 吞 click 语义一致）
  useEffect(() => {
    if (!menuOpen) return;
    const swallowClick = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("click", swallowClick, true);
    };
    const onPointerDown = (e: Event): void => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest(".msg-menu")) return; // 点在菜单内：交给菜单按钮自身处理
      setMenuOpen(false);
      document.addEventListener("click", swallowClick, true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", swallowClick, true);
    };
  }, [menuOpen]);

  return (
    <div
      id={`msg-${message.id}`}
      ref={measureRef}
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
                    <MsgImage key={`${message.id}-img-${i}`} src={img.url} alt={img.alt ?? "图片"} />
                  ))}
                </div>
              )}
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={`${message.id}-tool-${i}`} toolCall={tc} onOpenFile={onOpenFile} />
              ))}
              {empty && streaming && <StreamingPlaceholder />}
              {/* 有错误时绝不再显示「（无内容）」：那正是用户最不知所措的空气泡 */}
              {empty && !streaming && errorInfo === null && <span className="hint-text">（无内容）</span>}
              {errorInfo !== null && (
                <div
                  className={errorInfo.tone === "muted" ? "msg-error muted" : "msg-error"}
                  role={errorInfo.tone === "error" ? "alert" : undefined}
                >
                  <span className="msg-error-text">
                    {errorInfo.tone === "error" ? "⚠️ " : "⏹ "}
                    {errorInfo.text}
                  </span>
                  {errorInfo.canCompact && onCompact && (
                    <button type="button" className="msg-error-action" onClick={onCompact}>
                      压缩上下文
                    </button>
                  )}
                </div>
              )}
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
                    <MsgImage key={`${message.id}-img-${i}`} src={img.url} alt={img.alt ?? "图片"} />
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
        {message.role === "user" && sendFailed && (
          <div className="send-failed" role="alert">
            <span className="send-failed-text">⚠️ 发送失败</span>
            {sendQueued && (
              <span className="send-queued-tag" title="已入离线队列，网络恢复后自动按序重发">
                📶 等待发送
              </span>
            )}
            <button type="button" className="send-retry" onClick={onRetry} aria-label="重发这条消息">
              重试
            </button>
          </div>
        )}

        {menuOpen && (
          <>
            {/* 纯视觉遮罩（pointer-events: none）：点击/触摸空白关菜单在 document 监听里处理 */}
            <div className="msg-menu-backdrop" aria-hidden="true" />
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
});
