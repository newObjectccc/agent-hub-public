import { ChatSkeleton } from "../components/Skeletons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { api } from "../api/client";
import { sendPromptWithMode, type SendMode } from "../api/prompt";
import type { CommandItem, SessionMessage, SessionStatus, SessionSummary } from "../api/types";
import { applyWsEvent, type WsEvent } from "../chat/messageStream";
import { useGitStatus } from "../hooks/useGitStatus";
import { OLDER_PAGE_LIMIT, mergeOlderMessages, oldestMessageId, shouldLoadOlder, TAIL_MESSAGE_LIMIT } from "../chat/history";
import { useSessionSocket } from "../hooks/useSessionSocket";
import type { FileRef } from "../utils/fileRefs";
import { FileViewer } from "../components/FileViewer";
import { GitPanel } from "../components/GitPanel";
import { GitStatusBadge } from "../components/GitStatusBadge";
import { FileTreePanel } from "../components/FileTreePanel";
import { MessageBubble } from "../components/MessageBubble";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { UploadButton } from "../components/UploadButton";
import { SendModeSwitch } from "../components/SendModeSwitch";
import { SessionActionsMenu } from "../components/SessionActionsMenu";
import { SlashCommandPanel } from "../components/SlashCommandPanel";import { SourceBadge } from "../components/SourceBadge";
import { StatusBadge } from "../components/StatusBadge";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { BackIcon, TreeIcon } from "../components/icons";
import { PullToRefresh } from "../components/PullToRefresh";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { insertSnippet } from "../utils/insert";
import type { PanelKeyHandle } from "../utils/panelNav";
import { quoteSummary, withQuote } from "../utils/quote";
import { addRecentRef, loadRecentRefs, safeStorage, saveRecentRefs } from "../utils/recentRefs";
import {
  applyCommandInsert,
  applyFileInsert,
  detectCommandTrigger,
  detectToken,
  firstSlashCommand,
  type TokenSpan,
} from "../utils/slashInput";
import {
  buildSendText,
  dataUrlToBase64,
  imageRefs,
  MAX_ATTACHMENTS,
  readFileAsDataUrl,
  stripUploadRef,
  validateUploadFile,
  type Attachment,
} from "../utils/uploads";
import { showToast } from "../utils/toast";
import { findMessageByText } from "../utils/search";
import { chatPath, chatReturnPath, currentLocate, navigate, treePath } from "../utils/router";

/**
 * 权威消息合并已并入 messageStream.applyWsEvent 的 message_end 分支：
 * 同 id 覆盖 → 尾部占位（流式 live-/stream-、user 乐观 local-）合并 → 追加。
 * 所有 WS 事件统一经 applyWsEvent 处理，避免双路由绕过去重兜底。
 *
 * 历史消息懒加载：首屏只拉尾部 ~50 条，上滑/按钮加载更早一页；
 * 流式新消息到达保持原有尾部追加行为。
 */
/** message_end 后无任何流事件/状态事件的待定收尾时长：超时推断回复完成（status 回 idle） */
const REPLY_IDLE_FALLBACK_MS = 5_000;

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
  /** 同步防重入闸门（与 sending state 双保险）：快速连点只发一条 */
  const sendingRef = useRef(false);
  /** message_end 后的待定收尾定时器（tail 丢 status / 事件丢失时的 UI 兜底） */
  const pendingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>("auto");
  // 上传附件（📎 选择 / 粘贴图片）：上传成功 → 预览条 + 输入框 `@path` 引用
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // @ 面板“最近引用”快捷区（localStorage 持久化）
  const [recentRefs, setRecentRefs] = useState<string[]>(() => {
    const storage = safeStorage();
    return storage ? loadRecentRefs(storage) : [];
  });
  const [forkBusy, setForkBusy] = useState(false);
  // slash 命令面板：输入 `/` 触发（光标前 token），继续输入即过滤
  const [slashSpan, setSlashSpan] = useState<TokenSpan | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  // @ 文件树面板：输入 `@` 触发；多选插入 `@rel/path` 引用
  const [atSpan, setAtSpan] = useState<TokenSpan | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  // 引用回复条（长按消息 → 引用）
  const [quote, setQuote] = useState<{ text: string } | null>(null);  const [notice, setNotice] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitFile, setGitFile] = useState<string | null>(null);
  const [fileRef, setFileRef] = useState<FileRef | null>(null);
  // 搜索定位参数（?q= 关键词 / ?m= 消息 id）：一次性消费，避免每帧抢滚动
  const locate = useMemo(() => currentLocate(), []);
  const locatedRef = useRef(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // git 状态（chat 顶栏状态条 + 文件弹层“看 diff”判定）
  const gitStatus = useGitStatus(session?.cwd);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 输入框容器（ui/textarea 不转发 ref，从容器内取真实 textarea） */
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  /** 输入框文本镜像（连续上传/插入时避免闭包旧值） */
  const inputRef = useRef("");
  /** slash / @ 面板键盘句柄（↓/↑/Tab 从输入框下探到面板） */
  const slashPanelRef = useRef<PanelKeyHandle | null>(null);
  const filePanelRef = useRef<PanelKeyHandle | null>(null);  /** 面板关闭后不因持续输入同一 token 反复重开（token 消失后复位） */
  const slashDismissedRef = useRef(false);
  const atDismissedRef = useRef(false);
  const slashActiveRef = useRef(false);
  const atActiveRef = useRef(false);
  const commandsLoadedFor = useRef<string | null>(null);
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

  const source = session?.source ?? "pi";

  // 命令清单按 source 分发拉取（首触 `/` 时懒加载，缓存到 source 变更）
  useEffect(() => {
    if (!slashOpen || commandsLoadedFor.current === source) return;
    let cancelled = false;
    setCommandsLoading(true);
    setCommandsError(null);
    api
      .getCommands(source)
      .then((list) => {
        if (cancelled) return;
        setCommands(list.commands);
        commandsLoadedFor.current = source;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCommandsError(e instanceof Error ? e.message : "命令清单加载失败");
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, source]);

  /** 同步光标处 `/cmd` / `@path` 触发 token（onChange / 光标移动均调） */
  const syncTriggers = (el: HTMLTextAreaElement) => {
    const cursor = el.selectionStart ?? el.value.length;
    const slash = detectCommandTrigger(el.value, cursor);
    const at = detectToken(el.value, cursor, "@");
    if (slash !== null && !slashActiveRef.current && !slashDismissedRef.current) {
      setSlashOpen(true);
    }
    slashActiveRef.current = slash !== null;
    if (slash === null) slashDismissedRef.current = false;
    setSlashSpan(slash);
    if (at !== null && !atActiveRef.current && !atDismissedRef.current) {
      setFileOpen(true);
    }
    atActiveRef.current = at !== null;
    if (at === null) atDismissedRef.current = false;
    setAtSpan(at);
  };

  /** 插入后恢复输入框焦点与光标 */
  const focusAt = (cursor: number) => {
    window.requestAnimationFrame(() => {
      const el = inputWrapRef.current?.querySelector("textarea");
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  /** 统一更新输入框（state + 镜像） */
  const updateInput = (text: string) => {
    inputRef.current = text;
    setInput(text);
  };

  /** 记录最近引用（@ 面板“最近引用”快捷区） */
  const rememberRef = (path: string) => {
    setRecentRefs((prev) => {
      const next = addRecentRef(prev, path);
      const storage = safeStorage();
      if (storage) saveRecentRefs(storage, next);
      return next;
    });
  };

  /** 在光标处插入 `@path ` 引用（尾随空格便于连续输入；上传/最近引用共用） */
  const insertRefText = (path: string) => {
    const el = inputWrapRef.current?.querySelector("textarea");
    const cursor = el?.selectionStart ?? inputRef.current.length;
    const result = applyFileInsert(inputRef.current, { start: cursor, end: cursor, query: "" }, [path]);
    updateInput(result.text);
    focusAt(result.cursor);
    rememberRef(path);
  };

  /** 单文件上传：本地预检 → base64 → POST /api/uploads（契约 §11）→ 附件草稿 */
  const uploadOne = async (file: File): Promise<Attachment | null> => {
    const problem = validateUploadFile(file);
    if (problem) {
      showToast(problem);
      return null;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const { upload } = await api.uploadFile({
      sessionId,
      name: file.name,
      mimeType: file.type,
      data: dataUrlToBase64(dataUrl),
    });
    return {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: upload.name,
      path: upload.path,
      mimeType: upload.mimeType,
      size: upload.size,
      isImage: upload.isImage,
      preview: upload.isImage ? dataUrl : null,
    };
  };

  /** 📎 选择 / 粘贴文件（逐个串行上传，成功即插入引用） */
  const handleFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      showToast(`单条消息最多 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const picked = files.slice(0, room);
    if (files.length > room) showToast(`超出上限，仅上传前 ${room} 个`);
    setUploading(true);
    try {
      for (const file of picked) {
        try {
          const att = await uploadOne(file);
          if (!att) continue;
          setAttachments((prev) => [...prev, att]);
          insertRefText(att.path);
        } catch (e) {
          showToast(`${file.name}：上传失败（${e instanceof Error ? e.message : "未知错误"}）`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  /** 粘贴图片/文件（剪贴板带文件时拦截并走上传） */
  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void handleFiles(files);
  };

  /** 删除附件：同步清掉输入框里的 `@path` 引用 */
  const removeAttachment = (id: string) => {
    const target = attachments.find((a) => a.id === id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (target) updateInput(stripUploadRef(inputRef.current, target.path));
  };

  /** 选中命令：把 `/token` 替换为 `/cmd `（尾随空格便于连续输参数）；claude 内置命令给降级提示 */
  const pickCommand = (name: string) => {
    const el = inputWrapRef.current?.querySelector("textarea");
    const span = slashSpan ?? (el ? detectCommandTrigger(el.value, el.selectionStart ?? el.value.length) : null);
    const result = applyCommandInsert(
      inputRef.current,
      span ?? { start: inputRef.current.length, end: inputRef.current.length, query: "" },
      name,
    );
    updateInput(result.text);
    setSlashSpan(null);
    setSlashOpen(false);
    slashActiveRef.current = false;
    focusAt(result.cursor);
    const item = commands.find((c) => c.name === name);
    if (item?.terminalOnly) {
      showToast("该命令仅终端可用（当前通道无法执行，发送会成为普通消息），已插入供参考");
    }
  };

  /** 文件树多选插入：`@rel/path1 @rel/path2`（替换 `@token` 或插到光标处） */
  const insertFileRefs = (paths: string[]) => {
    const el = inputWrapRef.current?.querySelector("textarea");
    const cursor = el?.selectionStart ?? inputRef.current.length;
    const span = atSpan ?? { start: cursor, end: cursor, query: "" };
    const result = applyFileInsert(inputRef.current, span, paths);
    updateInput(result.text);
    setAtSpan(null);
    atActiveRef.current = false;
    focusAt(result.cursor);
    for (const path of paths) rememberRef(path);
  };

  // 消息到位后：有定位参数则高亮并滚动到命中消息（滚动到底交给下方 useLayoutEffect）
  useEffect(() => {
    if (messages.length === 0 || locatedRef.current) return;
    locatedRef.current = true;
    const hitId = locate.messageId
      ? messages.find((m) => m.id === locate.messageId)?.id ?? findMessageByText(messages, locate.q ?? "")
      : findMessageByText(messages, locate.q ?? "");
    if (hitId) {
      setHighlightId(hitId);
      // 等待高亮 class 落 DOM 后再滚动，确保元素存在
      window.requestAnimationFrame(() => {
        document.getElementById(`msg-${hitId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [messages, locate]);
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

  const clearPendingIdle = () => {
    if (pendingIdleRef.current) {
      clearTimeout(pendingIdleRef.current);
      pendingIdleRef.current = null;
    }
  };

  /** 回复落盘后的待定收尾：短静默无任何事件 → 本轮回复完成，中止按钮随 status 消失 */
  const armPendingIdle = () => {
    clearPendingIdle();
    pendingIdleRef.current = setTimeout(() => {
      pendingIdleRef.current = null;
      setStatus((s) => (s === "running" ? "idle" : s));
      setSending(false);
      setSendMode("auto");
    }, REPLY_IDLE_FALLBACK_MS);
  };

  useEffect(() => () => clearPendingIdle(), []);

  const handleEvent = useCallback(
    (event: WsEvent) => {
      switch (event.type) {
        case "message_start":
        case "text_delta":
        case "thinking_delta":
        case "tool_start":
        case "tool_end":
          // 流事件说明 agent 还在跑：取消待定收尾，中止按钮保持；
          // 若 5s 待定误翻了 idle（段间长间隙），后续流事件自愈恢复 running
          clearPendingIdle();
          setStatus((prev) => (prev === "running" ? prev : "running"));
          // 全部消息流事件统一走 applyWsEvent（含 message_end 去重兜底与占位回填）
          setMessages((prev) => applyWsEvent(prev, event));
          break;
        case "message_end":
          setMessages((prev) => applyWsEvent(prev, event));
          // 回复落盘：若 status 事件丢失（tail 静默判定/事件丢发），待定超时自动翻转 idle
          if ((event.message?.role ?? "assistant") === "assistant") armPendingIdle();
          break;
        case "status": {
          clearPendingIdle();
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
          clearPendingIdle();
          setStatus("idle");
          setSending(false);
          setSendMode("auto");
          break;
        case "error":
          clearPendingIdle();
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
    // 同步防重入：React state 未 flush 的极速双击/多通道触发也只发一条（快速双击 bug）
    if (sendingRef.current) return;
    const raw = inputRef.current.trim();
    // 附件兜底：正文为空但仍有附件时用引用行；引用回复拼 Markdown 引用块（`> `）
    const base = buildSendText(raw, attachments);
    const text = quote ? withQuote(quote.text, base) : base;
    if (!text) return;
    sendingRef.current = true;
    const sent = attachments;
    const images = imageRefs(sent);
    setSending(true);
    setNotice(null);
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const previewImages = sent
      .filter((a) => a.isImage && a.preview !== null)
      .map((a) => ({ url: a.preview as string, alt: a.name }));
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        role: "user",
        timestamp: Date.now(),
        text,
        toolCalls: [],
        ...(previewImages.length > 0 ? { images: previewImages } : {}),
      },
    ]);
    updateInput("");
    setAttachments([]);
    setQuote(null);
    try {
      // auto：409 自动降级（prompt → followUp）；手动模式直接带对应 mode；
      // 图片附件随 prompt 上传（pi 直接附图，claude 走 @path 引用，契约 §1/§11）
      const outcome = await sendPromptWithMode(
        sessionId,
        text,
        sendMode,
        {
          sendPrompt: api.sendPrompt,
          onNotice: setNotice,
        },
        images.length > 0 ? images : undefined,
      );
      if (!outcome.result.accepted) {
        setNotice("消息未被接受，请稍后重试");
      } else {
        setStatus("running");
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "发送失败");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const doAbort = async () => {
    try {
      await api.abortSession(sessionId);
      clearPendingIdle();
      setNotice("已发送中止请求");
      setSending(false);
      setStatus("idle");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "中止失败");
    }
  };

  /** 复制为新会话（fork）：完整上下文→独立新会话，原会话不受影响；成功后跳进新会话 */
  const doFork = async () => {
    if (forkBusy) return;
    setForkBusy(true);
    setNotice(null);
    try {
      const { session } = await api.forkSession(sessionId);
      navigate(chatPath(session.id));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "复制会话失败");
    } finally {
      setForkBusy(false);
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

  const hasContent = input.trim() !== "" || attachments.length > 0;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="back"
          onClick={() => navigate(chatReturnPath())}
          aria-label="返回列表"
        >
          <BackIcon />
        </Button>
        <div className="chat-title">
          <div className="name">{session?.name ?? sessionId}</div>
          <div className="cwd">{session?.cwd ?? ""}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="chat-tree-btn"
          onClick={() => navigate(treePath(sessionId))}
          aria-label="查看会话分支树"
        >
          <TreeIcon />
          树
        </Button>
        {/* 子代理来源标记：pi-subagents 派生会话在顶栏明示 */}
        {session?.isSubAgent === true && (
          <span className="badge subagent" title="pi-subagents 派生的子代理会话">
            🤖 子代理
          </span>
        )}
        <SessionActionsMenu onFork={() => void doFork()} forkBusy={forkBusy} />
        <SourceBadge source={session?.source ?? null} />
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
            <MessageBubble
              key={m.id}
              message={m}
              highlight={m.id === highlightId}
              onOpenFile={setFileRef}
              onQuote={(msg) => setQuote({ text: msg.text })}
            />
          ))}
          <div ref={bottomRef} />
        </PullToRefresh>
      </div>

      <footer className="chat-input">
        {quote && (
          <div className="quote-bar" role="status" aria-label="引用消息">
            <span className="quote-label">引用</span>
            <span className="quote-text">{quoteSummary(quote.text)}</span>
            <button type="button" className="quote-cancel" onClick={() => setQuote(null)} aria-label="取消引用">
              ✕
            </button>
          </div>
        )}
        {status === "running" && (
          <div className="run-bar">
            <SendModeSwitch value={sendMode} onChange={setSendMode} />
            <Button type="button" variant="destructive" size="sm" onClick={() => void doAbort()}>
              中止
            </Button>
          </div>
        )}
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
        <div className="composer">          <SlashCommandPanel
            ref={slashPanelRef}
            open={slashOpen && slashSpan !== null}
            source={source}
            commands={commands}
            loading={commandsLoading}
            error={commandsError}
            query={slashSpan?.query ?? ""}
            onSelect={pickCommand}
            onClose={() => setSlashOpen(false)}
            anchorRef={inputWrapRef}
          />
          {fileOpen && session && (
            <FileTreePanel
              ref={filePanelRef}
              open={fileOpen}
              cwd={session.cwd}
              recent={recentRefs}
              onPickRecent={insertRefText}
              onInsert={insertFileRefs}
              anchorRef={inputWrapRef}
              onClose={() => {
                setFileOpen(false);
                atDismissedRef.current = true;
              }}
            />
          )}
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
          <div className="composer-box">
            <div className="chat-textarea-wrap" ref={inputWrapRef}>
              <Textarea
                className="composer-textarea"
                placeholder="输入消息…（/ 命令，@ 引用，📎 上传，Enter 发送）"
                value={input}
                rows={1}
                onChange={(e) => {
                  updateInput(e.target.value);
                  syncTriggers(e.target);
                }}
                onClick={(e) => syncTriggers(e.currentTarget)}
                onKeyUp={(e) => syncTriggers(e.currentTarget)}
                onSelect={(e) => syncTriggers(e.currentTarget)}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (fileOpen) {
                      setFileOpen(false);
                      atDismissedRef.current = true;
                      e.preventDefault();
                      return;
                    }
                    if (slashOpen) {
                      setSlashOpen(false);
                      slashDismissedRef.current = true;
                      e.preventDefault();                      return;
                    }
                  }
                  // 面板键盘下探：↓/↑/Tab 把焦点交给面板（方向键循环、Tab 逐项、Enter 插入）
                  const openPanel = slashSpan !== null ? slashPanelRef : atSpan !== null ? filePanelRef : null;
                  if (openPanel && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab")) {
                    e.preventDefault();
                    if (e.key === "ArrowUp") openPanel.current?.focusLast();
                    else openPanel.current?.focusFirst();
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    // 面板开着：Enter 选中过滤结果第一项（与点击一致）
                    if (slashOpen && slashSpan) {
                      const first = firstSlashCommand(commands, slashSpan.query);
                      if (first) {
                        pickCommand(first.name);
                        return;
                      }
                    }
                    void doSend();
                  }
                }}
                aria-label="消息输入框"
              />
            </div>
            <div className="composer-actions">
              <UploadButton onFiles={(files) => void handleFiles(files)} busy={uploading} />
              <VoiceInputButton
                onTranscript={(text) => updateInput(insertSnippet(inputRef.current, text))}
                disabled={sending}
              />
              <button
                type="button"
                className={`composer-send${hasContent ? " ready" : ""}`}
                onClick={() => void doSend()}
                disabled={sending || !hasContent}
                aria-label="发送"
              >
                {sending ? (
                  <>
                    <span className="spinner" />
                    <span className="send-text">发送中…</span>
                  </>
                ) : (
                  <>
                    <span className="send-icon" aria-hidden="true">
                      ➤
                    </span>
                    <span className="send-text">发送</span>
                  </>
                )}
              </button>
            </div>
          </div>
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
