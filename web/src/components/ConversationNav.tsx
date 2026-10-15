/**
 * 对话导航条（Codex app 风格）：消息区左缘刻度时间线。
 * - 每条消息一个刻度：长度按内容量映射、角色分色（条形码效果）
 * - 亮色横条 = 当前视口位置，可拖拽快速滚动
 * - 悬停/键盘聚焦刻度 → 消息预览卡（标题 + 摘要 + 序号/时间）
 * - 点击/回车刻度 → onJump 跳转到该消息
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { MessageRole, SessionMessage } from "../api/types";
import {
  buildNavTicks,
  tickLength,
  tickTimeLabel,
  viewportRatio,
  type NavTick,
} from "../chat/navTicks";

/** 角色徽标（预览卡右上角 + aria 描述） */
const ROLE_META: Record<MessageRole, { icon: string; label: string }> = {
  user: { icon: "👤", label: "你" },
  assistant: { icon: "🤖", label: "助手" },
  toolResult: { icon: "🔧", label: "工具结果" },
  custom: { icon: "💬", label: "消息" },
};

/** 预览卡定位：刻度右侧弹出，视口边缘自动夹紧/左翻 */
function previewPosition(tickRect: DOMRect, cardW: number, cardH: number): { left: number; top: number } {
  const margin = 12;
  let left = tickRect.right + margin;
  if (left + cardW > window.innerWidth - 8) left = tickRect.left - cardW - margin;
  if (left < 8) left = 8;
  const centerY = tickRect.top + tickRect.height / 2;
  const top = Math.min(Math.max(8, centerY - cardH / 2), Math.max(8, window.innerHeight - cardH - 8));
  return { left, top };
}

export interface ConversationNavProps {
  messages: SessionMessage[];
  /** 消息滚动容器（指示器跟随 + 拖拽滚动目标） */
  scrollRef: RefObject<HTMLElement | null>;
  /** 点击刻度跳转（由会话页实现：挂载直接滚 / 未挂载先估算滚动再微调） */
  onJump: (id: string) => void;
}

function ConversationNavInner({ messages, scrollRef, onJump }: ConversationNavProps) {
  const ticks = useMemo(() => buildNavTicks(messages), [messages]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** 悬停预览目标（null = 不显示） */
  const [preview, setPreview] = useState<{ tick: NavTick; left: number; top: number } | null>(null);
  /** 视口指示器几何（轨道比例 0..1） */
  const [thumb, setThumb] = useState({ top: 0, height: 1 });

  // 指示器跟随滚动/内容尺寸（rAF 合并高频 scroll）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setThumb(
        viewportRatio({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }),
      );
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (raf === 0) raf = requestAnimationFrame(update);
          })
        : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [scrollRef, messages.length]);

  const showPreview = useCallback((tick: NavTick, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    // 卡片尺寸未知时先按估值定位，渲染后误差由 clamp 兜底（悬停低频，不值得二次布局）
    const pos = previewPosition(rect, 320, 150);
    setPreview({ tick, left: pos.left, top: pos.top });
  }, []);

  const hidePreview = useCallback(() => setPreview(null), []);

  /** 指针拖拽指示器 → 按视口中心比例滚动（不依赖 tick 几何，与浏览器滚动条同手感） */
  const scrollToRatio = useCallback(
    (clientY: number) => {
      const el = scrollRef.current;
      const track = trackRef.current;
      if (!el || !track) return;
      const rect = track.getBoundingClientRect();
      if (!(rect.height > 0)) return;
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(max, Math.max(0, ratio * el.scrollHeight - el.clientHeight / 2));
    },
    [scrollRef],
  );

  const onThumbPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onTrackPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) scrollToRatio(e.clientY);
    },
    [scrollToRatio],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  if (ticks.length === 0) return null;

  return (
    <nav className="chat-nav" aria-label="对话导航">
      <div
        className="chat-nav-track"
        ref={trackRef}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={hidePreview}
      >
        {ticks.map((tick) => (
          <button
            key={tick.id}
            type="button"
            className={`chat-nav-tick ${tick.role}`}
            aria-label={`第 ${tick.index + 1} 条，${ROLE_META[tick.role].label}：${tick.title}`}
            onClick={() => onJump(tick.id)}
            onPointerEnter={(e) => showPreview(tick, e.currentTarget)}
            onFocus={(e) => showPreview(tick, e.currentTarget)}
            onBlur={hidePreview}
          >
            <span className="chat-nav-dash" style={{ width: tickLength(tick.weight) }} />
          </button>
        ))}
        <div
          className="chat-nav-thumb"
          role="scrollbar"
          aria-label="当前视口位置，可拖拽滚动"
          style={{
            top: `${(thumb.top + thumb.height / 2) * 100}%`,
            height: `clamp(3px, ${thumb.height * 100}%, 28px)`,
          }}
          onPointerDown={onThumbPointerDown}
        />
      </div>
      {preview !== null &&
        createPortal(
          <div className="chat-nav-preview" style={{ left: preview.left, top: preview.top }} role="tooltip">
            <div className="chat-nav-preview-head">
              <span className="chat-nav-preview-title">{preview.tick.title}</span>
              <span className="chat-nav-preview-icon" aria-hidden="true">
                {ROLE_META[preview.tick.role].icon}
              </span>
            </div>
            {preview.tick.preview && <div className="chat-nav-preview-text">{preview.tick.preview}</div>}
            <div className="chat-nav-preview-meta">
              <span>
                {ROLE_META[preview.tick.role].label} · 第 {preview.tick.index + 1}/{ticks.length} 条
              </span>
              <span>{tickTimeLabel(preview.tick.timestamp)}</span>
            </div>
          </div>,
          document.body,
        )}
    </nav>
  );
}

export const ConversationNav = memo(ConversationNavInner);
