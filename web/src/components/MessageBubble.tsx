import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { probeRender } from "../utils/renderProbe";
import type { MessageError, SessionMessage } from "../api/types";
import { copyText } from "../utils/clipboard";
import type { FileRef } from "../utils/fileRefs";
import { LongPressDetector } from "../utils/longPress";
import { layoutMenu } from "../utils/menuPosition";
import { countChars, readSelectionText } from "../utils/selection";
import { armTrailingClick } from "../utils/trailingClick";
import { showToast } from "../utils/toast";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";
import { CopyIcon, MoreIcon } from "./icons";

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const COPY_SUCCESS_TOAST = "已复制消息文本";
export const COPY_FAIL_TOAST = "复制失败，请手动选择文本";
export const COPY_SELECTION_TOAST = "已复制所选文字";

/** 长按按住时长 ≥ 该值且抬手时有活动选区 → 判定为选词手势，吞其尾随 click */
const SELECT_PRESS_MS = 400;

/** 桌面（精确指针）判定；jsdom/老内核无 matchMedia 时按桌面处理（右键走自带菜单） */
function isFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(pointer: fine)").matches === true;
}

/**
 * contextmenu 来源判定（触屏 / 桌面）双保险：
 * matchMedia("(pointer: fine)") + sourceCapabilities.firesTouchEvents（Chrome）——
 * 触屏笔记本等混合设备只看其一会误判（误判时触屏长按会退回旧 bug：文本选不了）。
 */
function isTouchContextMenu(e: React.MouseEvent): boolean {
  const caps = (e.nativeEvent as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
    .sourceCapabilities;
  if (caps?.firesTouchEvents === true) return true;
  return !isFinePointer();
}

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

/**
 * 消息气泡：user 右侧，assistant 左侧（markdown 渲染），思维链折叠块 + toolCalls 折叠卡片。
 * highlight=true 时高亮（搜索定位 ?q= 跳转命中消息）；onOpenFile 点击文件引用打开弹层。
 *
 * 复制交互（两层，别再退回“长按劫持选字”的旧路）：
 * - 整条复制：脚部行 .msg-foot 的复制图标，一触即复制 message.text（markdown 源文口径不变）；
 * - 部分文字：文本区长按/右键**放行系统**选词与 callout（触屏 contextmenu 不 preventDefault），
 *   iOS/Android 原生选字复活；菜单内「复制所选（N 字）」兜底（打开时读 getSelection，兼容 iOS<17.4）。
 * 长按菜单保留做进阶（复制所选/复制文本/全选/引用）：热区在脚部行（非文本区）+ ⋯ 按钮；
 * 桌面右键（pointer:fine）气泡同菜单。菜单锚定按压点 + 视口 clamp（修长消息菜单飞出屏幕旧 bug）。
 * 图片例外：不拦截长按/右键，让 Android Chrome 原生"保存图片"菜单工作。
 * streaming 消息（message_start → message_end）：空内容显示"✍️ 回复中…"活占位（绝不显示"（无内容）"），
 * 气泡带进行中微光；同会话并行回合（sub agent 并行）带 🔗 序号标记。
 *
 * 渲染性能：React.memo（message 引用未变的历史消息不随相邻消息更新重渲）；
 * measureRef 供长会话窗口化测量行高（传入方须保持引用稳定，否则 memo 失效）。
 */
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
  /** 菜单锚点（视口坐标）；null = 关闭。开时顺带快照选区文本（复制所选口径） */
  const [menu, setMenu] = useState<{ anchorX: number; anchorY: number; selection: string } | null>(null);
  const menuOpen = menu !== null;
  const hasText = message.text.trim() !== "";
  const images = message.images ?? [];
  const streaming = message.streaming === true;
  const empty = message.text === "" && message.toolCalls.length === 0 && !thinking && images.length === 0;
  // 错误条（仅 assistant：server 只对 assistant 消息提取 stopReason）
  const errorInfo = message.role === "assistant" ? describeMessageError(message.error) : null;
  /** 引用消息以 Markdown 引用块开头（`> `），用 markdown 渲染让两端 agent 口径一致 */
  const isQuoted = /^>\s?/.test(message.text);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 按压起点（指针坐标 + 时刻 + 当时选区）：长按锚点 / 选词手势判定 */
  const pressRef = useRef({ x: 0, y: 0, at: 0, sel: "", valid: false });

  // 图片目标不进入长按状态机（交还系统菜单）
  const isImageTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.tagName === "IMG";

  const isFootTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.closest(".msg-foot") != null;

  // 长按识别：纯状态机（定时器默认实现；单测直接测 LongPressDetector）——热区只在脚部行，
  // 文本区长按交给系统选词（不得再抢：那是“部分文字复制”的主路径）
  const detector = useMemo(
    () =>
      new LongPressDetector(() => {
        armTrailingClick(pressRef.current.x, pressRef.current.y);
        openMenu(pressRef.current.x, pressRef.current.y);
      }),
    [],
  );
  useEffect(() => () => detector.cancel(), [detector]);

  const openMenu = (x: number, y: number): void => {
    setMenu({ anchorX: x, anchorY: y, selection: readSelectionText() });
  };

  // 菜单定位：按压点锚定 + 视口 clamp（layoutMenu 纯函数）。锚点是视口坐标，
  // 菜单是 .msg-body（position:relative）的绝对定位子节点 → 换算回 body 相对坐标。
  // 用 offsetWidth/offsetHeight（布局尺寸，不受 fade-up transform 影响），jsdom 为 0 时退化。
  // 菜单渲染在 .chat-messages 滚动容器内（超出被裁剪）→ 纵向 clamp 以容器可见区为界；
  // 视口变化（旋转/键盘弹出）时重算，避免菜单停在旧坐标被裁。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const position = (): void => {
      const bodyRect = bodyRef.current?.getBoundingClientRect();
      const scrollerRect = bodyRef.current
        ?.closest(".chat-messages")
        ?.getBoundingClientRect();
      const { left, top } = layoutMenu({
        anchorX: menu.anchorX,
        anchorY: menu.anchorY,
        width: el.offsetWidth,
        height: el.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        clipTop: scrollerRect?.top,
        clipBottom: scrollerRect?.bottom,
      });
      el.style.left = `${bodyRect ? left - bodyRect.left : left}px`;
      el.style.top = `${bodyRect ? top - bodyRect.top : top}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("orientationchange", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("orientationchange", position);
    };
  }, [menu]);

  const handleCopy = async () => {
    setMenu(null);
    const ok = await copyText(message.text);
    showToast(ok ? COPY_SUCCESS_TOAST : COPY_FAIL_TOAST);
  };

  const handleCopySelection = async () => {
    const sel = menu?.selection ?? "";
    setMenu(null);
    const ok = await copyText(sel);
    showToast(ok ? COPY_SELECTION_TOAST : COPY_FAIL_TOAST);
  };

  /** 全选：Range 选中 .bubble 渲染内容（所见即所选的渲染纯文本，区别于 message.text 源文） */
  const handleSelectAll = () => {
    setMenu(null);
    const bubble = bubbleRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!bubble || !sel || typeof document.createRange !== "function") return;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const handleQuote = () => {
    setMenu(null);
    onQuote?.(message);
  };

  const handleMore = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left + r.width / 2, r.top + r.height / 2);
  };

  // 菜单开着时"点击/触摸空白处关闭"：backdrop 不拦截 hit-test（见 styles.css 注释，
  // fixed 层会把触摸拖动的滚动目标变成 window，消息区拖不动），改由 document 捕获监听；
  // 关闭那一击由 armTrailingClick 吞掉（不落到下方内容），且新手势的 pointerdown 会解除
  // 武装——旧实现的 swallowClick 随 effect cleanup 被误删 / 残留吞无关 click 两个竞态都消掉
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: Event): void => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest(".msg-menu")) return; // 点在菜单内：交给菜单按钮自身处理
      const pe = e as PointerEvent;
      setMenu(null);
      armTrailingClick(pe.clientX ?? 0, pe.clientY ?? 0);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  return (
    <div
      id={`msg-${message.id}`}
      ref={measureRef}
      className={`msg-row ${message.role}${highlight ? " search-hit" : ""}${streaming ? " streaming" : ""}`}
    >
      <div
        className="msg-body"
        ref={bodyRef}
        onPointerDown={(e) => {
          pressRef.current = {
            x: e.clientX,
            y: e.clientY,
            at: Date.now(),
            sel: readSelectionText(),
            valid: true,
          };
          // 长按状态机只挂脚部行（非文本区）：文本区长按交给系统选词
          if (!hasText || menuOpen || !isFootTarget(e.target)) return;
          detector.start(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => detector.move(e.clientX, e.clientY)}
        onPointerUp={() => {
          const longPressed = detector.end();
          const press = pressRef.current;
          pressRef.current = { ...press, valid: false };
          if (longPressed) return; // 长按开菜单路径已在松手时 arm 尾随 click
          // 选词手势（按住 ≥400ms 且**本次手势期间选区从无到有/发生变化**）→ 内核可能补发
          // 尾随 click，吞一次。必须校验选区是本手势产生的：旧选区残留时慢点按钮（400-500ms
          // 按住复制/菜单项）不应吞掉自身 click（否则按钮假死）；无配对 pointerdown（拖拽跨界
          // 释放）时 valid=false 不误吞
          const held = press.valid && Date.now() - press.at >= SELECT_PRESS_MS;
          const selNow = readSelectionText();
          if (held && selNow !== "" && selNow !== press.sel) {
            armTrailingClick(press.x, press.y);
          }
        }}
        onPointerCancel={() => detector.cancel()}
        onContextMenu={(e) => {
          // 图片：不拦截，交给系统长按菜单（Android Chrome “保存图片”）
          if (isImageTarget(e.target)) return;
          if (!hasText) return;
          // 触屏长按文本：放行系统选词/复制 callout（部分文字复制主路径，绝不再 preventDefault）；
          // 桌面右键 / 脚部行长按：走自带菜单
          const inFoot = isFootTarget(e.target);
          const touch = isTouchContextMenu(e);
          if (!inFoot && touch) return;
          e.preventDefault();
          detector.cancel();
          if (touch) armTrailingClick(e.clientX, e.clientY);
          openMenu(e.clientX, e.clientY);
        }}
      >
        <div className="bubble" ref={bubbleRef}>
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
        <div className="msg-foot">
          <span className="msg-time">{timeLabel(message.timestamp)}</span>
          {hasText && (
            <div className="msg-actions">
              <button
                type="button"
                className="msg-copy-btn"
                aria-label={streaming ? "复制当前已生成文本" : "复制这条消息"}
                title={streaming ? "复制当前已生成文本" : "复制这条消息"}
                onClick={() => void handleCopy()}
              >
                <CopyIcon />
              </button>
              <button
                type="button"
                className="msg-more-btn"
                aria-label="更多操作"
                title="更多操作"
                onClick={handleMore}
              >
                <MoreIcon />
              </button>
            </div>
          )}
        </div>
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
            <div className="msg-menu" role="menu" aria-label="消息操作" ref={menuRef}>
              {menu.selection !== "" && (
                <button type="button" role="menuitem" className="msg-menu-item" onClick={() => void handleCopySelection()}>
                  复制所选（{countChars(menu.selection)} 字）
                </button>
              )}
              <button type="button" role="menuitem" className="msg-menu-item" onClick={() => void handleCopy()}>
                复制文本
              </button>
              <button type="button" role="menuitem" className="msg-menu-item" onClick={handleSelectAll}>
                全选
              </button>
              {onQuote && (
                <button type="button" role="menuitem" className="msg-menu-item" onClick={handleQuote}>
                  引用
                </button>
              )}
              <button type="button" role="menuitem" className="msg-menu-item" onClick={() => setMenu(null)}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
