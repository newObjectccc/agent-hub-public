import { ChatSkeleton } from "../components/Skeletons";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { sendPromptWithFallback } from "../api/prompt";
import type { SessionMessage, SessionStatus, SessionSummary } from "../api/types";
import { applyWsEvent, type WsEvent } from "../chat/messageStream";
import { useGitStatus } from "../hooks/useGitStatus";
import { useSessionSocket } from "../hooks/useSessionSocket";
import type { FileRef } from "../utils/fileRefs";
import { FileViewer } from "../components/FileViewer";
import { GitPanel } from "../components/GitPanel";
import { GitStatusBadge } from "../components/GitStatusBadge";
import { MessageBubble } from "../components/MessageBubble";
import { StatusBadge } from "../components/StatusBadge";
import { BackIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { navigate } from "../utils/router";

/**
 * 权威消息合并已并入 messageStream.applyWsEvent 的 message_end 分支：
 * 同 id 覆盖 → 尾部占位（流式 live-/stream-、user 乐观 local-）合并 → 追加。
 * 所有 WS 事件统一经 applyWsEvent 处理，避免双路由绕过去重兜底。
 */
export function ChatPage({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitFile, setGitFile] = useState<string | null>(null);
  const [fileRef, setFileRef] = useState<FileRef | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // git 状态（chat 顶栏状态条 + 文件弹层“看 diff”判定）
  const gitStatus = useGitStatus(session?.cwd);

  /** GET /api/sessions/:id 全量对账（首屏加载 + WS 重连后） */
  const loadSession = useCallback(async () => {
    try {
      const detail = await api.getSession(sessionId);
      setSession(detail.session);
      setMessages(detail.messages ?? []);
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

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
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
          if (s !== "running") setSending(false);
          break;
        }
        case "agent_settled":
          // 本轮工作全部结束：恢复输入
          setStatus("idle");
          setSending(false);
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
      const outcome = await sendPromptWithFallback(sessionId, text, {
        sendPrompt: api.sendPrompt,
        onNotice: setNotice,
      });
      setStatus("running");
      if (!outcome.result.accepted) {
        setNotice("消息未被接受，请稍后重试");
        setSending(false);
      }
      // accepted：等待 agent_settled / status 事件恢复输入
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "发送失败");
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

      {session && (
        <div className="chat-subbar">
          <GitStatusBadge cwd={session.cwd} onClick={() => { setGitFile(null); setGitOpen(true); }} />
          <Button type="button" variant="secondary" size="xs" onClick={() => { setGitFile(null); setGitOpen(true); }}>
            变更
          </Button>
        </div>
      )}

      <div className="chat-messages" role="log" aria-label="对话消息">
        {loading && messages.length === 0 && <ChatSkeleton count={4} />}
        {loadError && (
          <div className="error-banner">
            <span>{loadError}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => void loadSession()}>
              重试
            </Button>
          </div>
        )}
        {!loading && !loadError && messages.length === 0 && (
          <div className="empty">还没有消息，发送第一条吧</div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onOpenFile={setFileRef} />
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="chat-input">
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
          {status === "running" ? (
            <Button type="button" variant="destructive" onClick={() => void doAbort()}>
              中止
            </Button>
          ) : (
            <Button type="button" onClick={() => void doSend()} disabled={sending || !input.trim()}>
              发送
            </Button>
          )}
        </div>
      </footer>

      {gitOpen && session && (
        <GitPanel
          cwd={session.cwd}
          initialTab="diff"
          initialFile={gitFile}
          onClose={() => setGitOpen(false)}
        />
      )}

      {fileRef && session && (
        <FileViewer
          cwd={session.cwd}
          path={fileRef.path}
          line={fileRef.line}
          hasDiff={Boolean(gitStatus?.dirty.some((d) => d.path === fileRef.path))}
          onViewDiff={() => {
            setGitFile(fileRef.path);
            setFileRef(null);
            setGitOpen(true);
          }}
          onClose={() => setFileRef(null)}
        />
      )}
    </div>
  );
}
