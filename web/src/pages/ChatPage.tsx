import { ChatSkeleton } from "../components/Skeletons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { sendPromptWithMode, type SendMode } from "../api/prompt";
import type { SessionMessage, SessionStatus, SessionSummary } from "../api/types";
import { applyWsEvent, type WsEvent } from "../chat/messageStream";
import { OLDER_PAGE_LIMIT, mergeOlderMessages, oldestMessageId, shouldLoadOlder, TAIL_MESSAGE_LIMIT } from "../chat/history";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { MessageBubble } from "../components/MessageBubble";
import { QuickCommandPanel } from "../components/QuickCommandPanel";
import { SendModeSwitch } from "../components/SendModeSwitch";
import { StatusBadge } from "../components/StatusBadge";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { BackIcon } from "../components/icons";
import { PullToRefresh } from "../components/PullToRefresh";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { insertSnippet } from "../utils/quickCommands";
import { navigate } from "../utils/router";

/**
 * 权威消息合并已并入 messageStream.applyWsEvent 的 message_end 分支：
 * 同 id 覆盖 → 尾部占位（流式 live-/stream-、user 乐观 local-）合并 → 追加。
 * 所有 WS 事件统一经 applyWsEvent 处理，避免双路由绕过去重兜底。
 *
 * 历史消息懒加载：首屏只拉尾部 ~50 条，上滑/按钮加载更早一页；
 * 流式新消息到达保持原有尾部追加行为。
 */
export function ChatPage({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMode, setSendMode] = useState<SendMode>("auto");
  const [quickOpen, setQuickOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<SessionMessage[]>([]);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  /** 用户是否停在底部（不在底部时不自动滚底，避免与读历史冲突） */
  const stickToBottomRef = useRef(true);
  /** 前插更早消息后按锚点恢复滚动位置（不触发自动滚底） */
  const pendingRestoreRef = useRef<{ height: number; top: number } | null>(null);

  messagesRef.current = messages;
  hasMoreRef.current = hasMore;
  loadingOlderRef.current = loadingOlder;

  /** GET /api/sessions/:id 对账（首屏加载 + WS 重连后）：尾部窗口 = 已加载条数 */
  const loadSession = useCallback(async () => {
    try {
      const loaded = messagesRef.current.length;
      const detail = await api.getSession(sessionId, {
        limit: Math.max(TAIL_MESSAGE_LIMIT, loaded),
      });
      setSession(detail.session);
      setMessages(detail.messages ?? []);
      setHasMore(Boolean(detail.hasMore));
      setStatus(detail.session.status);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "会话加载失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 上滑加载更早一页（before 游标 = 当前最早消息 id） */
  const loadOlder = useCallback(async () => {
    const anchor = oldestMessageId(messagesRef.current);
    if (!anchor || loadingOlderRef.current || !hasMoreRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const height = el?.scrollHeight ?? 0;
    const top = el?.scrollTop ?? 0;
    try {
      const page = await api.getSession(sessionId, { before: anchor, limit: OLDER_PAGE_LIMIT });
      pendingRestoreRef.current = { height, top };
      setMessages((prev) => mergeOlderMessages(prev, page.messages ?? []));
      setHasMore(Boolean(page.hasMore));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "更早消息加载失败");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [sessionId]);

  // 前插历史：按锚点保持视口；尾部新消息/流式：自动滚底（保持既有行为）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const restore = pendingRestoreRef.current;
    if (restore && el) {
      pendingRestoreRef.current = null;
      el.scrollTop = el.scrollHeight - restore.height + restore.top;
      return;
    }
    if (!stickToBottomRef.current || !bottomRef.current) return;
    // 大跨度跳到底部用瞬时滚动：避免平滑动画穿过顶部误触发"加载更早"
    if (el) {
      const target = el.scrollHeight - el.clientHeight;
      const behavior: ScrollBehavior = Math.abs(target - el.scrollTop) > el.clientHeight ? "auto" : "smooth";
      bottomRef.current.scrollIntoView?.({ behavior, block: "end" });
    } else {
      bottomRef.current.scrollIntoView?.({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const handleEvent = useCallback(
    (event: WsEvent) => {
      switch (event.type) {
        case "message_start":
        case "text_delta":
        case "tool_start":
        case "tool_end":
        case "message_end":
          // 全部消息流事件统一走 applyWsEvent（含 message_end 去重兜底与占位回填）
          setMessages((prev) => applyWsEvent(prev, event));
          break;
        case "status": {
          const s = (event.status ?? "idle") as SessionStatus;
          setStatus(s);
          if (s !== "running") {
            setSending(false);
            setSendMode("auto");
          }
          break;
        }
        case "agent_settled":
          // 本轮工作全部结束：恢复输入
          setStatus("idle");
          setSending(false);
          setSendMode("auto");
          break;
        case "error":
          setNotice(event.message ? String(event.message) : `${event.code ?? "错误"}：运行期错误`);
          setSending(false);
          break;
        default:
          break;
      }
    },
    [],
  );

  useSessionSocket({
    sessionId,
    onEvent: handleEvent,
    onReconnect: () => void loadSession(),
    onStatusChange: setConnected,
  });

  const doSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    const localId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: localId, role: "user", timestamp: Date.now(), text, toolCalls: [] },
    ]);
    setInput("");
    try {
      // auto：409 自动降级（prompt → followUp）；手动模式直接带对应 mode
      const outcome = await sendPromptWithMode(sessionId, text, sendMode, {
        sendPrompt: api.sendPrompt,
        onNotice: setNotice,
      });
      if (!outcome.result.accepted) {
        setNotice("消息未被接受，请稍后重试");
      } else {
        setStatus("running");
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const doAbort = async () => {
    try {
      await api.abortSession(sessionId);
      setNotice("已发送中止请求");
      setSending(false);
      setStatus("idle");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "中止失败");
    }
  };

  /** 下拉刷新：还有更早消息时等价"加载更早"，否则刷新对账 */
  const ptrRefresh = async () => {
    if (hasMoreRef.current) {
      await loadOlder();
      return;
    }
    setRefreshing(true);
    try {
      await loadSession();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="chat-page">
      <header className="chat-header">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="back"
          onClick={() => navigate("/")}
          aria-label="返回面板"
        >
          <BackIcon />
        </Button>
        <div className="chat-title">
          <div className="name">{session?.name ?? sessionId}</div>
          <div className="cwd">{session?.cwd ?? ""}</div>
        </div>
        <StatusBadge status={status} />
      </header>

      {notice && <div className="chat-notice">{notice}</div>}

      <div
        className="chat-messages"
        role="log"
        aria-label="对话消息"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // 停在底部附近才跟随新消息；向上翻历史时不被拉回
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
          if (shouldLoadOlder({ scrollTop: el.scrollTop, hasMore: hasMoreRef.current, loading: loadingOlderRef.current })) {
            void loadOlder();
          }
        }}
      >
        <PullToRefresh
          onRefresh={ptrRefresh}
          refreshing={loadingOlder || refreshing}
          contentClassName="chat-stream"
          idleLabel={hasMore ? "下拉加载更早消息" : "下拉刷新"}
          readyLabel={hasMore ? "松开加载更早消息" : "松开刷新"}
          busyLabel={loadingOlder ? "加载更早消息…" : "刷新中…"}
        >
          {hasMore && (
            <button type="button" className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "正在加载更早消息…" : "↑ 加载更早消息"}
            </button>
          )}
          {loading && messages.length === 0 && <ChatSkeleton count={4} />}
          {loadError && (
            <div className="error-banner">
              <span>{loadError}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => void loadSession()}>
                重试
              </Button>
            </div>
          )}
          {!loading && !loadError && messages.length === 0 && <div className="empty">还没有消息，发送第一条吧</div>}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </PullToRefresh>
      </div>

      <footer className="chat-input">
        {status === "running" && <SendModeSwitch value={sendMode} onChange={setSendMode} />}
        {status === "running" && (
          <div className="typing-indicator">
            <span className="spinner" />
            <span>agent 运行中…</span>
            {!connected && <span>（连接断开，重连中）</span>}
          </div>
        )}
        {status !== "running" && !connected && (
          <div className="typing-indicator">连接断开，重连中…（历史消息不会丢）</div>
        )}
        <div className="chat-input-row">
          <QuickCommandPanel
            open={quickOpen}
            onInsert={(text) => setInput((prev) => insertSnippet(prev, text))}
            onClose={() => setQuickOpen(false)}
          />
          <button
            type="button"
            className={`tool-btn${quickOpen ? " active" : ""}`}
            aria-label="快捷指令"
            aria-expanded={quickOpen}
            onClick={() => setQuickOpen((v) => !v)}
          >
            ⚡
          </button>
          <VoiceInputButton onTranscript={(text) => setInput((prev) => insertSnippet(prev, text))} disabled={sending} />
          <Textarea
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void doSend();
              }
            }}
            aria-label="消息输入框"
          />
          <Button type="button" onClick={() => void doSend()} disabled={sending || !input.trim()} aria-label="发送">
            {sending ? (
              <>
                <span className="spinner" />
                发送中…
              </>
            ) : (
              "发送"
            )}
          </Button>
          {status === "running" && (
            <Button type="button" variant="destructive" size="sm" onClick={() => void doAbort()}>
              中止
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
