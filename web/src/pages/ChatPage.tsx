import { ChatSkeleton } from "../components/Skeletons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type CSSProperties } from "react";
import { api, ApiError } from "../api/client";
import {
  isAttachSending,
  loadAttachMode,
  loadIntroSeen,
  mapAttachSendMode,
  markIntroSeen,
  saveAttachMode,
  type AttachMode,
  type ChannelEchoState,
} from "../api/attach";
import { sendPromptWithMode, type SendMode } from "../api/prompt";
import { getOfflineQueue, appendLocalAttachmentHints, classifySendError, queuedImagesOf, type QueuedSend } from "../chat/offlineQueue";
import { flushOfflineQueue } from "../chat/offlineFlush";
import type { CommandItem, SessionMessage, SessionStatus, SessionSummary, SubAgentActivity, TerminalAttachInfo } from "../api/types";
import { applyWsEvent, reconcileMessages, type WsEvent } from "../chat/messageStream";
import { waitPhaseAfterEvent, type WaitPhase } from "../chat/waitPhase";
import { DeltaBatcher } from "../chat/deltaBatcher";
import { computeMessageWindow, paddingTopFor, pruneDetachedRowEls } from "../chat/messageWindow";
import { isSubAgentActivityUpdate, mergeSubAgentActivity } from "../chat/subAgents";
import { useGitStatus } from "../hooks/useGitStatus";
import { useVisualViewportInset } from "../hooks/useVisualViewportInset";
import { OLDER_PAGE_LIMIT, mergeOlderMessages, oldestMessageId, shouldLoadOlder, TAIL_MESSAGE_LIMIT } from "../chat/history";
import { locateWithPaging } from "../chat/locate";
import { resolveRoundEndMode } from "../chat/sendMode";
import { useSessionSocket } from "../hooks/useSessionSocket";
import type { FileRef } from "../utils/fileRefs";
import { FileViewer } from "../components/FileViewer";
import { GitPanel } from "../components/GitPanel";
import { FileTreePanel } from "../components/FileTreePanel";
import { MessageBubble } from "../components/MessageBubble";
import { SubAgentPanel } from "../components/SubAgentPanel";
import { DrivenBadge } from "../components/DrivenBadge";
import { WaitStageBar } from "../components/WaitStageBar";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { AttachIntroSheet } from "../components/AttachIntroSheet";
import { AttachModeMenu } from "../components/AttachModeMenu";
import { ChannelEcho } from "../components/ChannelEcho";
import { UploadButton } from "../components/UploadButton";
import { SendModeMenu } from "../components/SendModeMenu";
import { SessionActionsMenu } from "../components/SessionActionsMenu";
import { RenameSessionSheet } from "../components/RenameSessionSheet";
import { SlashCommandPanel } from "../components/SlashCommandPanel";
import { QuickCommandPanel } from "../components/QuickCommandPanel";
import { StatusBadge } from "../components/StatusBadge";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { BackIcon, GitBranchIcon, StopIcon, TreeIcon } from "../components/icons";
import { PullToRefresh } from "../components/PullToRefresh";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { insertSnippet, insertSnippetAtCursor } from "../utils/insert";
import { withDateDividers } from "../utils/dateDivider";
import { vibrate } from "../utils/haptics";
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
  isImageMime,
  MAX_ATTACHMENTS,
  readFileAsDataUrl,
  stripUploadRef,
  validateUploadFile,
  type Attachment,
} from "../utils/uploads";
import { showToast } from "../utils/toast";
import { DRAFT_SAVE_DEBOUNCE_MS, clearDraft, loadDraft, saveDraft } from "../utils/drafts";
import { COMPOSITION_COOLDOWN_MS, PhysicalKeyboardTracker, shouldSendOnEnter } from "../utils/keyboard";
import { prefersReducedMotion, scrollBehaviorOf } from "../utils/motion";
import { shouldFollowToBottom } from "../utils/scrollPolicy";
import { chatPath, chatReturnPath, currentLocate, navigate, onRouteChange, treePath, type ChatLocate } from "../utils/router";

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
/** 停在底部附近才跟随新消息的阈值（px，语义不变） */
const STICK_TO_BOTTOM_PX = 160;
/** 长会话窗口化：消息数达到该值才启用（短会话零开销） */
const VIRTUAL_MIN_COUNT = 60;
/** 窗口化视口外上下多渲染的消息条数 */
const VIRTUAL_OVERSCAN = 6;
/** 窗口收缩/扩展限速（条/次）：避免一次性卸载大量 DOM 造成巨帧（渐进逼近） */
const MAX_WINDOW_STEP = 24;

/** 输入框自增高上限：6 行（行高 ≈ 21px × 6 + 内边距 12px），超出内部滚动 */
const TEXTAREA_MAX_HEIGHT = 140;

function autoGrowTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
}

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
  const [input, setInput] = useState<string>(() => loadDraft(safeStorage(), sessionId) ?? "");
  const [sending, setSending] = useState(false);
  /** 同步防重入闸门（与 sending state 双保险）：快速连点只发一条 */
  const sendingRef = useRef(false);
  /** 发送/重试触发的强制回底（发送 = 显式「看底部」意图，区别于被动收消息的贴底跟随） */
  const forceScrollRef = useRef(false);
  /** 阶段化等待反馈：发送中 → 思考中 → 工具执行中 → 回复中（null = 空闲不显示） */
  const [wait, setWait] = useState<{ phase: WaitPhase; startedAt: number } | null>(null);
  const waitRef = useRef(wait);
  waitRef.current = wait;
  /** 进入等待（保留本轮起点：阶段切换不清零计时） */
  const beginWait = (phase: WaitPhase) => {
    const startedAt = waitRef.current?.startedAt ?? Date.now();
    waitRef.current = { phase, startedAt };
    setWait(waitRef.current);
  };
  /** WS 事件推进阶段（tool_start → 工具执行中，text_delta → 回复中…） */
  const advanceWait = (eventType: string) => {
    const prev = waitRef.current;
    const nextPhase = waitPhaseAfterEvent(prev?.phase ?? "thinking", eventType);
    // 同阶段不 setState：高频 delta（批处理域）不因阶段条击穿渲染合并
    if (prev !== null && prev.phase === nextPhase) return;
    waitRef.current = { phase: nextPhase, startedAt: prev?.startedAt ?? Date.now() };
    setWait(waitRef.current);
  };
  /** 本轮回复结束（完成/中止/失败）：状态条消失 */
  const endWait = () => {
    waitRef.current = null;
    setWait(null);
  };
  /** 发送失败/待发送（F1 持久离线队列）：刷新/杀 App 不丢；failedSends 已升级为本队列 */
  const queueStore = getOfflineQueue();
  const queueItems = useSyncExternalStore(queueStore.subscribe, queueStore.list, queueStore.list);
  const sessionQueue = useMemo(() => queueItems.filter((i) => i.sessionId === sessionId), [queueItems, sessionId]);
  const queuedById = useMemo(() => new Map(sessionQueue.map((i) => [i.localId, i])), [sessionQueue]);
  /** 待发送队列浮层（📶 徽章点击展开，逐条重试/删除） */
  const [queueOpen, setQueueOpen] = useState(false);
  /** 会话最后驱动来源（心理预期管理）：面板驱动过 → panel */
  const [drivenBy, setDrivenBy] = useState<"panel" | "terminal">(() => {
    const storage = safeStorage();
    return storage?.getItem(`agent-hub.panelHint.v1:${sessionId}`) === "1" ? "panel" : "terminal";
  });
  /** 预期提示条（面板驱动过的会话首次进入显示，"知道了"后记住关闭） */
  const [driverHint, setDriverHint] = useState(false);
  /** 任务生命周期预期提示（发送后显示，✕ 后记住不再显示） */
  const [bgHintDismissed, setBgHintDismissed] = useState<boolean>(() => {
    const storage = safeStorage();
    return storage?.getItem("agent-hub.bgHint.v1") === "1";
  });
  const dismissBgHint = () => {
    setBgHintDismissed(true);
    try {
      safeStorage()?.setItem("agent-hub.bgHint.v1", "1");
    } catch {
      /* 存储不可用：仅本次会话内关闭 */
    }
  };
  /** ↓ 新消息浮标：上翻历史时到达的新消息条数（不拉扯视口） */
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(0);
  const prevTailRef = useRef<string | null>(null);
  /** i1：首屏对账填充（loadSession）不算“新消息”——刚打开会话不该弹浮标 */
  const initialFillRef = useRef(false);
  /** 移动端键盘避让：被键盘遮住的高度 → CSS 变量抬高输入区 */
  const kbInset = useVisualViewportInset();
  /** message_end 后的待定收尾定时器（tail 丢 status / 事件丢失时的 UI 兜底） */
  const pendingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>("auto");
  /** 发送模式镜像（WS 事件回调/回合收尾读最新值，避免闭包过期） */
  const sendModeRef = useRef<SendMode>(sendMode);
  sendModeRef.current = sendMode;
  /** 回合结束的发送模式复位（UX 审查 AC4）：粘性选择（⚡ 自动/💬 新消息）保留不静默重置；
   * 一次性模式（✋ 插话/⏭ 排队，仅对本轮生效）复位为自动并给一行轻提示 */
  const resetSendModeAfterRound = () => {
    const next = resolveRoundEndMode(sendModeRef.current);
    if (next.mode !== sendModeRef.current) {
      sendModeRef.current = next.mode;
      setSendMode(next.mode);
    }
    if (next.notice) setNotice(next.notice);
  };
  /** 输入法组合结束后的 Enter 冷却截止（UX 审查 AC4：防中文输入法回车误发） */
  const compositionCooldownUntilRef = useRef(0);
  /** 物理键盘探测（触屏 + 外接键盘时允许 Enter 发送） */
  const kbTrackerRef = useRef<PhysicalKeyboardTracker | null>(null);
  if (kbTrackerRef.current === null) kbTrackerRef.current = new PhysicalKeyboardTracker();
  useEffect(() => {
    const tracker = kbTrackerRef.current;
    if (!tracker) return;
    const onKeydown = (e: KeyboardEvent) => tracker.handleKeydown(e);
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, []);
  // 双模式会话驱动（E3）：📱 parallel（现状）/ 🖥 attach（消息注入电脑终端 pi）
  const [attachMode, setAttachMode] = useState<AttachMode>(() => loadAttachMode(safeStorage(), sessionId));
  const attachModeRef = useRef<AttachMode>(attachMode);
  attachModeRef.current = attachMode;
  /** 本地 attachMode 校正（server 是事实源）：只同步本地状态与持久化，不做 attach 握手 */
  const applyAttachMode = useCallback(
    (mode: AttachMode) => {
      if (attachModeRef.current === mode) return;
      attachModeRef.current = mode;
      setAttachMode(mode);
      saveAttachMode(safeStorage(), sessionId, mode);
    },
    [sessionId],
  );
  /** 终端 pi 在线/接管状态（server 真值，WS attach_state 实时更新） */
  const [terminal, setTerminal] = useState<TerminalAttachInfo | null>(null);
  /** 发送后归属确认一行小字（独立状态字，不侵入 E1 阶段状态条） */
  const [echo, setEcho] = useState<ChannelEchoState | null>(null);
  /** 指令回执先于发送响应到达时的时序保护：commandId → 回执结果 */
  const ackedRef = useRef(new Map<string, { ok: boolean; error: string | null }>());
  const [attachBusy, setAttachBusy] = useState(false);
  // 首次进入可双模式会话的轻量说明 sheet（一次性，用完即走）
  const [introOpen, setIntroOpen] = useState(false);
  const introCheckedRef = useRef(false);
  // 子代理活动（反馈轮 3 #4）：pi-subagents 派生会话的实时工作面板（快照 + WS 增量）
  const [subAgents, setSubAgents] = useState<SubAgentActivity[]>([]);
  // 面板驱动标识（反馈轮 3 #5，与驱动来源徽章统一）：本设备面板发过消息的会话，电脑端 pi 需重开才能看到实时变化
  const panelHintShownRef = useRef(false);
  // 上传附件（📎 选择 / 粘贴图片）：上传成功 → 预览条 + 输入框 `@path` 引用
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // @ 面板“最近引用”快捷区（localStorage 持久化）
  const [recentRefs, setRecentRefs] = useState<string[]>(() => {
    const storage = safeStorage();
    return storage ? loadRecentRefs(storage) : [];
  });
  const [forkBusy, setForkBusy] = useState(false);
  // 重命名会话（SessionActionsMenu「重命名」→ RenameSessionSheet）
  const [renameOpen, setRenameOpen] = useState(false);
  // slash 命令面板：输入 `/` 触发（光标前 token），继续输入即过滤
  const [slashSpan, setSlashSpan] = useState<TokenSpan | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  /** 快捷指令面板（⚡ 模板一键插入） */
  const [quickOpen, setQuickOpen] = useState(false);
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
  // 搜索定位参数（?q= 关键词 / ?m= 消息 id）：每次带参进入会话都定位（含浏览器前进/后退回同一会话）
  const [locate, setLocate] = useState<ChatLocate>(() => currentLocate());
  // 定位参数整组变化（同会话再次深链）→ 重新定位；每次进入会话（重挂）自然重新定位
  const locateKey = `${locate.q ?? ""}\u0000${locate.messageId ?? ""}`;
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // 浏览器前进/后退带新定位参数回同一会话：跟随刷新定位目标（深链每次进入都能定位）
  useEffect(() => onRouteChange(() => setLocate(currentLocate())), []);

  // git 状态（chat 顶栏状态条 + 文件弹层“看 diff”判定）
  const gitStatus = useGitStatus(session?.cwd);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 消息列表层（长会话窗口化：滚动偏移按列表顶部折算） */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 输入框容器（ui/textarea 不转发 ref，从容器内取真实 textarea） */
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  /** 输入框文本镜像（连续上传/插入时避免闭包旧值） */
  const inputRef = useRef(input);
  /** 草稿落盘防抖定时器（UX 审查 AC1）：逐键写 localStorage 太频，防抖后写 */
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** slash / @ 面板键盘句柄（↓/↑/Tab 从输入框下探到面板） */
  const slashPanelRef = useRef<PanelKeyHandle | null>(null);
  const filePanelRef = useRef<PanelKeyHandle | null>(null);
  /** 快捷指令触发按钮（面板锚点，点它不误关面板） */
  const quickTriggerRef = useRef<HTMLButtonElement | null>(null);  /** 面板关闭后不因持续输入同一 token 反复重开（token 消失后复位） */
  const slashDismissedRef = useRef(false);
  const atDismissedRef = useRef(false);
  const slashActiveRef = useRef(false);
  const atActiveRef = useRef(false);
  const commandsLoadedFor = useRef<string | null>(null);
  const messagesRef = useRef<SessionMessage[]>([]);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  /** 前插更早消息后按锚点恢复滚动位置（不触发自动滚底） */
  const pendingRestoreRef = useRef<{ height: number; top: number } | null>(null);
  /** 上一次消息更新后的滚动内容总高（stick-to-bottom 判定用，见下方 useLayoutEffect） */
  const lastContentHeightRef = useRef(0);
  /** status 镜像（WS 事件回调里判断是否需要翻 running，避免每条 delta 一次 setState） */
  const statusRef = useRef<SessionStatus>("idle");

  messagesRef.current = messages;
  hasMoreRef.current = hasMore;
  loadingOlderRef.current = loadingOlder;
  statusRef.current = status;

  /** GET /api/sessions/:id 对账（首屏加载 + WS 重连后）：尾部窗口 = 已加载条数 */
  const loadSession = useCallback(async () => {
    try {
      const loaded = messagesRef.current.length;
      const detail = await api.getSession(sessionId, {
        limit: Math.max(TAIL_MESSAGE_LIMIT, loaded),
      });
      setSession(detail.session);
      // 对账保留在途流式标志（重连时占位不被误判为“（无内容）”）
      initialFillRef.current = true; // i1：首屏/对账填充不触发新消息浮标
      setMessages(reconcileMessages(messagesRef.current, detail.messages ?? []));
      setHasMore(Boolean(detail.hasMore));
      setStatus(detail.session.status);
      setTerminal(detail.session.terminal ?? null);
      // 双模式跨设备校正（server 是事实源）：电脑已 attach 接管而本机 localStorage 还是平行模式时，
      // parallel 发送会被 409 ATTACH_ACTIVE 挡死 → 按 server terminal.attached 校正本地模式
      const attachedFlag = detail.session.terminal?.attached;
      if (attachedFlag === true) applyAttachMode("attach");
      else if (attachedFlag === false) applyAttachMode("parallel");
      // 首次进入可双模式会话：一次性说明 sheet（记住选择，用完即走，不常驻）
      if (!introCheckedRef.current) {
        introCheckedRef.current = true;
        if (detail.session.terminal?.online === true && !loadIntroSeen(safeStorage())) {
          setIntroOpen(true);
        }
      }
      setLoadError(null);
      // 驱动来源标注（心理预期管理）：server 持久集合为准，本地 panelHint 仅旧版兼容兑底
      const driven = detail.session.lastDrivenBy === "panel" ? "panel" : "terminal";
      setDrivenBy((prev) => (prev === "panel" ? "panel" : driven));
      if (driven === "panel" && safeStorage()?.getItem(`agent-hub.driverHint.v1:${sessionId}`) !== "1") {
        setDriverHint(true);
      }
      // 从别处（如电脑终端）已在运行：进入即展示阶段条（起点取当下，无法回溯真实发送时刻）
      if (detail.session.status === "running") beginWait("thinking");
      // 子代理活动快照（失败静默降级：面板只是增强，不阻断会话）
      api
        .getSessionAgents(sessionId)
        .then(({ agents }) => setSubAgents(agents))
        .catch(() => undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "会话加载失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId, applyAttachMode]);

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

  /** 草稿防抖落盘（UX 审查 AC1）：只存文本，附件不持久化 */
  const scheduleDraftPersist = () => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      saveDraft(safeStorage(), sessionId, inputRef.current);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  };
  /** 立即清草稿（发送成功后调，防已发内容残留给下次恢复） */
  const clearDraftNow = () => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    clearDraft(safeStorage(), sessionId);
  };
  // 卸载/切会话前冲刷未落盘的草稿（输入框内容仅组件 state，不存就丢）
  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
        saveDraft(safeStorage(), sessionId, inputRef.current);
      }
    },
    [sessionId],
  );

  /** 统一更新输入框（state + 镜像） */
  const updateInput = (text: string) => {
    inputRef.current = text;
    setInput(text);
    scheduleDraftPersist();
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

  /** 快捷指令：模板插入到输入框光标处（保留光标后内容，换行衔接，可编辑后发送） */
  const insertQuickCommand = (text: string) => {
    const el = inputWrapRef.current?.querySelector("textarea");
    const cursor = el?.selectionStart ?? inputRef.current.length;
    const result = insertSnippetAtCursor(inputRef.current, cursor, text);
    updateInput(result.text);
    focusAt(result.cursor);
  };

  /** 单文件上传：本地预检 → base64 → POST /api/uploads（契约 §11）→ 附件草稿；
   * 网络失败时降级为本地暂存附件（uploaded:false，随消息入离线队列，F1） */
  const uploadOne = async (file: File): Promise<Attachment | null> => {
    const problem = validateUploadFile(file);
    if (problem) {
      showToast(problem);
      return null;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const base64 = dataUrlToBase64(dataUrl);
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { upload } = await api.uploadFile(
        // 有 cwd 直接用（免 findSession 全量扫描）；无 cwd 退回 sessionId 归属校验
        session?.cwd
          ? { cwd: session.cwd, name: file.name, mimeType: file.type, data: base64 }
          : { sessionId, name: file.name, mimeType: file.type, data: base64 },
      );
      return {
        id,
        name: upload.name,
        path: upload.path,
        mimeType: upload.mimeType,
        size: upload.size,
        isImage: upload.isImage,
        preview: upload.isImage ? dataUrl : null,
        uploaded: true,
        data: null,
      };
    } catch (e) {
      // 网络错误/5xx：本地暂存，随消息入离线队列（联网后补上传再发）
      if (classifySendError(e) === "network") {
        const isImage = isImageMime(file.type);
        showToast(`📶 ${file.name}：网络不可用，已本地暂存（随消息进入离线队列）`);
        return {
          id,
          name: file.name,
          path: "",
          mimeType: file.type,
          size: file.size,
          isImage,
          preview: isImage ? dataUrl : null,
          uploaded: false,
          data: base64,
        };
      }
      throw e;
    }
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
          // 离线暂存的附件无路径可引，发送时随消息入队后由 server 补引用
          if (att.uploaded !== false && att.path !== "") insertRefText(att.path);
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

  /** 删除附件：同步清掉输入框里的 `@path` 引用（离线暂存附件无引用可清） */
  const removeAttachment = (id: string) => {
    const target = attachments.find((a) => a.id === id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (target && target.uploaded !== false && target.path !== "") updateInput(stripUploadRef(inputRef.current, target.path));
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

  // 深链定位（UX 审查 AC2）：命中已加载范围 → 高亮 + 滚动；miss → 按 before 游标自动加载更早页
  // （≤LOCATE_MAX_PAGES 页）直到命中，仍未命中给轻提示（不再静默失败）。
  // 每次带参进入会话/定位参数变化都重新定位（不再一次性消费后永不回头）。
  const loadLocatePage = useCallback(async (beforeId: string) => {
    const page = await api.getSession(sessionId, { before: beforeId, limit: OLDER_PAGE_LIMIT });
    return { messages: page.messages ?? [], hasMore: Boolean(page.hasMore) };
  }, [sessionId]);

  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages || (locate.q == null && locate.messageId == null)) return;
    let cancelled = false;
    void (async () => {
      const result = await locateWithPaging({
        messages: messagesRef.current,
        hasMore: hasMoreRef.current,
        target: locate,
        loadOlder: loadLocatePage,
        onPageMerged: (merged, more) => {
          if (cancelled) return;
          // 前插更早消息：窗口下标整体位移 → 同步重置为全量（与 loadOlder 同口径）
          winStateRef.current = { virtualized: false, start: 0, paddingTop: 0 };
          setVirtualized(false);
          setWindowStart(0);
          setWindowPad(0);
          messagesRef.current = merged;
          setMessages(merged);
          setHasMore(more);
        },
      });
      if (cancelled) return;
      if (result.hitId) {
        const hitId = result.hitId;
        setHighlightId(hitId);
        // 等待高亮 class 落 DOM 后再滚动，确保元素存在；平滑滚动尊重 prefers-reduced-motion。
        // 有界重试（≤10 帧）：单发 rAF 在重负载/慢机下元素尚未 commit 时会静默跳过滚动（REV-J1 实测）
        let scrollTries = 0;
        const tryScrollToHit = () => {
          const el = document.getElementById(`msg-${hitId}`);
          if (el) {
            el.scrollIntoView({ behavior: scrollBehaviorOf(window), block: "center" });
            return;
          }
          if (++scrollTries < 10) window.requestAnimationFrame(tryScrollToHit);
        };
        window.requestAnimationFrame(tryScrollToHit);
      } else {
        showToast("未在已加载范围找到该消息");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locateKey, hasMessages, sessionId, loadLocatePage]);
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
      // 前插 P 条后 messages 下标整体位移，旧 windowStart 错位：同一更新批次重置为
      // 全量（前插行必然未测量，recomputeWindow 本就选全量，无性能损失），
      // 消除 slice(windowStart) 错位中间帧（渲染内容错位 → scrollHeight 恢复公式读错 → 跳动/夹底）
      winStateRef.current = { virtualized: false, start: 0, paddingTop: 0 };
      setVirtualized(false);
      setWindowStart(0);
      setWindowPad(0);
      setMessages((prev) => mergeOlderMessages(prev, page.messages ?? []));
      setHasMore(Boolean(page.hasMore));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "更早消息加载失败");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [sessionId]);

  // 前插历史：按锚点保持视口；尾部新消息/流式：自动滚底（保持既有行为）；
  // 用户上翻历史时尾部新到消息不拉扯视口，只累计到 ↓ 浮标（点击才回底部）
  // ===== 长会话窗口化（尾部锚定）：只裁顶部历史消息，尾部（流式）恒完整渲染 =====
  // ===== 长会话窗口化（尾部锚定）：只裁顶部历史消息，尾部（流式）恒完整渲染 =====
  /** 行高缓存（px，不含 flex gap）；高度不可测（jsdom）→ 不记录 → 窗口化自动禁用 */
  const heightsRef = useRef<Map<string, number>>(new Map());
  const rowElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);
  const windowRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  /** 窗口状态镜像：值未变不 setState（避免每帧一次无效 render） */
  const winStateRef = useRef({ virtualized: false, start: 0, paddingTop: 0 });
  const [virtualized, setVirtualized] = useState(false);
  const [windowStart, setWindowStart] = useState(0);
  const [windowPad, setWindowPad] = useState(0);

  /** 重算渲染窗口（一次布局读；值未变不 setState） */
  const recomputeRef = useRef<() => void>(() => undefined);

  /** rAF 合并窗口重算（滚动/测量/消息变化高频触发，每帧最多一次） */
  const scheduleWindowUpdate = useCallback(() => {
    if (windowRafRef.current !== null) return;
    windowRafRef.current = requestAnimationFrame(() => {
      windowRafRef.current = null;
      recomputeRef.current();
    });
  }, []);

  const recomputeWindow = useCallback(() => {
    const el = scrollRef.current;
    const listEl = listRef.current;
    if (!el || !listEl) return;
    // 清理已卸载行（ref 回调传 null 无法定位 id；窗口裁剪/消息替换都会留下 detached 条目）
    // 行高缓存保留：paddingTop 与重新挂载后复测都要用
    for (const { el: rowEl } of pruneDetachedRowEls(rowElsRef.current)) roRef.current?.unobserve(rowEl);
    const heights: number[] = [];
    let allMeasured = true;
    for (const m of messagesRef.current) {
      const h = heightsRef.current.get(m.id) ?? 0;
      if (!(h > 0)) allMeasured = false;
      heights.push(h);
    }
    // 搜索定位（?q= / ?m=）：命中消息必须挂载，禁用窗口化
    const locating = locate.q != null || locate.messageId != null;
    const win = locating
      ? { virtualized: false, start: 0, paddingTop: 0 }
      : computeMessageWindow({
          count: messagesRef.current.length,
          heights,
          allMeasured,
          // 列表顶部相对滚动内容顶部的偏移（加载更早按钮等）已折算进 scrollTop
          scrollTop: el.getBoundingClientRect().top - listEl.getBoundingClientRect().top,
          viewportHeight: el.clientHeight,
          minCount: VIRTUAL_MIN_COUNT,
          overscan: VIRTUAL_OVERSCAN,
        });
    // 值未变不 setState：rAF 级高频重算不触发无效 render（re-render 巡查）
    const prev = winStateRef.current;
    let nextStart = win.start;
    let nextPad = win.paddingTop;
    if (win.virtualized && Math.abs(nextStart - prev.start) > MAX_WINDOW_STEP) {
      // 渐进逼近：单次窗口变化限速（含首次全量→窗口收缩），避免巨帧；下帧继续收缩/扩展到目标
      nextStart = prev.start + Math.sign(nextStart - prev.start) * MAX_WINDOW_STEP;
      nextPad = paddingTopFor(heights, nextStart);
      scheduleWindowUpdate();
    }
    if (prev.virtualized !== win.virtualized || prev.start !== nextStart || prev.paddingTop !== nextPad) {
      winStateRef.current = { virtualized: win.virtualized, start: nextStart, paddingTop: nextPad };
      setVirtualized(win.virtualized);
      setWindowStart(nextStart);
      setWindowPad(nextPad);
    }
  }, [locate, scheduleWindowUpdate]);
  recomputeRef.current = recomputeWindow;

  /** 行高测量：高度 > 0 才记录（jsdom 兜底：不记录 → 窗口化禁用 → 全量渲染） */
  const measureRow = useCallback(
    (id: string, el: HTMLElement) => {
      const h = el.getBoundingClientRect().height || el.offsetHeight;
      if (!(h > 0)) return;
      if (heightsRef.current.get(id) !== h) {
        heightsRef.current.set(id, h);
        scheduleWindowUpdate();
      }
    },
    [scheduleWindowUpdate],
  );

  /** 消息行测量 ref（引用恒定，配合 MessageBubble 的 React.memo；id 从 DOM id `msg-<id>` 解析） */
  const rowMeasureRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const id = el.id.startsWith("msg-") ? el.id.slice(4) : "";
      if (!id) return;
      rowElsRef.current.set(id, el);
      roRef.current?.observe(el);
      measureRow(id, el);
    },
    [measureRow],
  );

  // 行高/视口尺寸变化跟踪（ResizeObserver 不可用时跳过，窗口化保持禁用）
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === scrollRef.current) {
          // 视口尺寸变化（横竖屏/键盘弹出）：重算窗口
          scheduleWindowUpdate();
          continue;
        }
        const id = target.id.startsWith("msg-") ? target.id.slice(4) : "";
        if (id) measureRow(id, target);
      }
    });
    roRef.current = ro;
    if (scrollRef.current) ro.observe(scrollRef.current);
    for (const el of rowElsRef.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, [measureRow, scheduleWindowUpdate]);

  /** 滚动处理：rAF 合并（滚动事件 60+/秒 → 每帧最多一次布局读 + 窗口重算，避免 layout thrash）。
   * stick-to-bottom 不在这里判定：决策点（消息提交的布局 effect）必须用实时滚动量，
   * 否则“用户上滚”与“流式提交”同帧时会读到过期的底部标志 → 错误自动滚底。 */
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      if (shouldLoadOlder({ scrollTop: el.scrollTop, hasMore: hasMoreRef.current, loading: loadingOlderRef.current })) {
        void loadOlder();
      }
      // i1 防御性二次校验：滚回底部（几何 <160px）立即清零浮标，不残留“已看见还提示”
      if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX) {
        setNewCount(0);
      }
      recomputeWindow();
    });
  }, [loadOlder, recomputeWindow]);

  // 卸载：丢弃未执行的 rAF（避免卸载后 setState）
  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (windowRafRef.current !== null) cancelAnimationFrame(windowRafRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const tailId = messages.length > 0 ? messages[messages.length - 1].id : null;
    const grew = messages.length > prevLenRef.current && tailId !== prevTailRef.current;
    // 发送/重试的强制回底：仅随真实新增消费，防被无关渲染吃掉标志
    const forceScroll = grew && forceScrollRef.current;
    if (forceScroll) forceScrollRef.current = false;
    const delta = Math.max(0, messages.length - prevLenRef.current);
    // i1 新消息浮标误报修复：首屏对账填充不计数——打开会话本来就在最新处
    const firstLoad = initialFillRef.current;
    initialFillRef.current = false;
    prevLenRef.current = messages.length;
    prevTailRef.current = tailId;
    // 贴底口径与 stick-to-bottom 同源（双口径任一 <160px 即视为跟随）：
    // - distancePrev（上次 effect 的内容高口径）：新消息把 scrollHeight 瞬时撑大时
    //   不会误判成“用户上翻”（旧口径只看当前几何 → 大消息贴底也弹浮标，根因）
    // - distanceNow：内容收缩/外部布局变化后的真实贴底
    const el0 = scrollRef.current;
    const distancePrev0 = el0 !== null ? lastContentHeightRef.current - el0.scrollTop - el0.clientHeight : Infinity;
    const distanceNow0 = el0 !== null ? el0.scrollHeight - el0.scrollTop - el0.clientHeight : Infinity;
    // distancePrev 仅在有历史高度基准时可信（首帧/无布局数据时不拿它判贴底）
    const nearBottom0 =
      distanceNow0 < STICK_TO_BOTTOM_PX ||
      (lastContentHeightRef.current > 0 && distancePrev0 < STICK_TO_BOTTOM_PX);
    if (grew && !firstLoad && !nearBottom0 && !forceScroll) {
      setNewCount((c) => c + delta);
    } else if (nearBottom0 || firstLoad || forceScroll) {
      setNewCount(0);
    }
    const el = scrollRef.current;
    const restore = pendingRestoreRef.current;
    if (restore && el) {
      pendingRestoreRef.current = null;
      el.scrollTop = el.scrollHeight - restore.height + restore.top;
      lastContentHeightRef.current = el.scrollHeight;
      scheduleWindowUpdate();
      return;
    }
    if (!el) return;
    // stick-to-bottom 判定（160px 语义不变）双口径：
    // - 更新前几何（上次 effect 时的内容总高 - 当前 scrollTop）：捕捉同帧“用户上滚 + 流式提交”
    //   （scroll 事件/rAF 尚未跑，但 scrollTop 已变 → 两种口径都超阈值 → 不拉底）
    // - 实时几何：捕捉内容收缩/外部布局变化后的贴底状态
    // 任一口径贴底即跟随：保住首屏加载/图片撑高时的一次性大增长（旧 ref 初始 true 语义）
    const distancePrev = lastContentHeightRef.current - el.scrollTop - el.clientHeight;
    const distanceNow = el.scrollHeight - el.scrollTop - el.clientHeight;
    lastContentHeightRef.current = el.scrollHeight;
    if (!shouldFollowToBottom({ force: forceScroll, distancePrev, distanceNow, threshold: STICK_TO_BOTTOM_PX })) return;
    // 大跨度跳到底部用瞬时滚动：避免平滑动画穿过顶部误触发"加载更早"；
    // 单次布局读 + 直接滚底（等价 scrollIntoView(block:end)，省掉整页布局计算）
    const target = el.scrollHeight - el.clientHeight;
    // 大跨度跳到底部用瞬时滚动：避免平滑动画穿过顶部误触发"加载更早"；
    // 平滑滚动一律尊重 prefers-reduced-motion（减少动态 → "auto"）
    const behavior: ScrollBehavior =
      prefersReducedMotion(window) || Math.abs(target - el.scrollTop) > el.clientHeight ? "auto" : "smooth";
    if (behavior === "smooth" && typeof el.scrollTo === "function") {
      el.scrollTo({ top: target, behavior: "smooth" });
    } else {
      el.scrollTop = target;
    }
    scheduleWindowUpdate();
  }, [messages, scheduleWindowUpdate]);

  const clearPendingIdle = () => {
    if (pendingIdleRef.current) {
      clearTimeout(pendingIdleRef.current);
      pendingIdleRef.current = null;
    }
  };

  /** 回复落盘后的待定收尾：短静默无任何事件 → 本轮回复完成，中止按钮与阶段条随 status 消失 */
  const armPendingIdle = () => {
    clearPendingIdle();
    pendingIdleRef.current = setTimeout(() => {
      pendingIdleRef.current = null;
      setStatus((s) => (s === "running" ? "idle" : s));
      setSending(false);
      resetSendModeAfterRound();
      endWait();
    }, REPLY_IDLE_FALLBACK_MS);
  };

  useEffect(() => () => clearPendingIdle(), []);

  // ===== WS 风暴批处理：text/thinking delta（可达 50+/秒）合并成批，一次 setMessages/一次渲染 =====
  const batcherRef = useRef<DeltaBatcher | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = new DeltaBatcher((events) => {
      // 批内相邻同 messageId 的 delta 已合并，reduce 一次 setState 应用整批
      clearPendingIdle();
      setMessages((prev) => events.reduce((acc, e) => applyWsEvent(acc, e), prev));
    });
  }
  useEffect(() => () => batcherRef.current?.cancel(), []);

  /** 流事件自愈 running：仅状态需翻转时 setState（高频 delta 不重复 setState） */
  const ensureRunning = () => {
    if (statusRef.current !== "running") setStatus("running");
  };

  const handleEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        // 高频 delta：缓冲合并到窗一批落盘（打字机观感无损，渲染次数大降）
        clearPendingIdle();
        ensureRunning();
        advanceWait(event.type); // 阶段推进（✍️ 回复中）不等批处理
        batcherRef.current?.push(event);
        return;
      }
      // 非 delta 事件前先落盘在途 delta（保序：message_end 占位合并依赖占位文本已完整）
      batcherRef.current?.flushNow();
      switch (event.type) {
        case "message_start":
        case "tool_start":
        case "tool_end":
          // 流事件说明 agent 还在跑：取消待定收尾，中止按钮保持；
          // 若 5s 待定误翻了 idle（段间长间隙），后续流事件自愈恢复 running
          clearPendingIdle();
          ensureRunning();
          // 阶段化等待反馈：按事件推进（思考中/工具执行中/回复中），计时不清零
          advanceWait(event.type);
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
            resetSendModeAfterRound();
            endWait();
          } else if (!waitRef.current) {
            beginWait("thinking");
          }
          break;
        }
        case "agent_settled":
          // 本轮工作全部结束：恢复输入，阶段条消失
          clearPendingIdle();
          setStatus("idle");
          setSending(false);
          resetSendModeAfterRound();
          endWait();
          break;
        case "subagent_activity": {
          // 子代理活动增量（反馈轮 3 #4）：按 sessionId 合并进活动面板
          const act = event.activity;
          if (isSubAgentActivityUpdate(act)) setSubAgents((prev) => mergeSubAgentActivity(prev, act));
          break;
        }
        case "error":
          clearPendingIdle();
          setNotice(event.message ? String(event.message) : `${event.code ?? "错误"}：运行期错误`);
          setSending(false);
          endWait();
          break;
        case "attach_state": {
          // 终端驱动状态实时回流（E3）：接管失效自动回落平行，绝不静默丢消息
          const attached = event.attached === true;
          const online = event.terminalOnline === true;
          setTerminal({ online, attached });
          if (!attached && attachModeRef.current === "attach") {
            applyAttachMode("parallel");
            setNotice("终端已退出接管（心跳超时或主动断开），已切回 📱 平行模式");
          }
          break;
        }
        case "command_ack": {
          if (attachModeRef.current !== "attach") break;
          const commandId = String(event.commandId ?? "");
          const ok = event.ok !== false;
          const error = event.error ? String(event.error) : null;
          ackedRef.current.set(commandId, { ok, error });
          // 旧指令的迟到回执不覆盖当前状态条
          setEcho((prev) => {
            if (prev && prev.channel === "attach" && prev.commandId && prev.commandId !== commandId) return prev;
            return ok
              ? { channel: "attach", phase: "acked", commandId }
              : { channel: "attach", phase: "failed", detail: error, commandId };
          });
          break;
        }
        default:
          break;
      }
    },
    [sessionId, applyAttachMode],
  );

  useSessionSocket({
    sessionId,
    onEvent: handleEvent,
    onReconnect: () => {
      void loadSession();
      // WS 重连 = 网络恢复：离线队列自动按序补发（F1）
      flushQueueNow(true);
    },
    onStatusChange: (connectedNow) => {
      setConnected(connectedNow);
      if (connectedNow) flushQueueNow(true);
    },
  });

  /** 发送失败 → 进持久离线队列（F1）：刷新/杀 App 不丢；网络错误自动重试，业务拒绝手动重试 */
  const enqueueFailedSend = (
    localId: string,
    text: string,
    atts: Attachment[],
    channel: "parallel" | "attach",
    autoRetry: boolean,
    error: string,
  ) => {
    const item: QueuedSend = {
      localId,
      sessionId,
      cwd: session?.cwd ?? "",
      text,
      images: queuedImagesOf(atts),
      sendMode,
      attachMode: mapAttachSendMode(sendMode),
      channel,
      queuedAt: Date.now(),
      attempts: 0,
      autoRetry,
      lastError: error,
    };
    const result = getOfflineQueue().add(item);
    if (!result.ok) showToast(result.reason);
  };

  /** 发送主链路（首发）：成功 → 思考中阶段 + 触觉反馈；失败 → 入离线队列（持久，可重试） */
  const performSend = async (localId: string, text: string, sent: Attachment[]) => {
    beginWait("sending");
    let atts = sent;
    const channel: "parallel" | "attach" = isAttachSending(attachModeRef.current, terminal) ? "attach" : "parallel";
    try {
      // 离线暂存附件补上传（正常路径选附件时已上传；这里只处理断网时本地暂存的）
      if (atts.some((a) => a.uploaded === false)) {
        const uploaded: Attachment[] = [];
        for (const att of atts) {
          if (att.uploaded !== false || !att.data) {
            uploaded.push(att);
            continue;
          }
          const { upload } = await api.uploadFile(
            session?.cwd
              ? { cwd: session.cwd, name: att.name, mimeType: att.mimeType, data: att.data }
              : { sessionId, name: att.name, mimeType: att.mimeType, data: att.data },
          );
          uploaded.push({ ...att, path: upload.path, uploaded: true, data: null });
        }
        atts = uploaded;
      }
      const imagePaths = imageRefs(atts);
      // 非图片附件补引用提示（与 server appendAttachmentHints 同口径，通道 a）
      const hintedText = appendLocalAttachmentHints(
        text,
        atts.filter((a) => !a.isImage && a.path !== "").map((a) => a.path),
      );
      if (channel === "attach") {
        // attach（E3 双模式）：消息入终端指令队列（终端 pi 实时显示并执行；回执经 WS command_ack 回流）
        const queued = await api.sendAttachMessage(sessionId, hintedText, mapAttachSendMode(sendMode), localId);
        // 时序保护：回执可能先于发送响应到达（长轮询秒级投递），已回执则直接展示终态
        const ack = ackedRef.current.get(queued.commandId);
        if (ack) {
          ackedRef.current.delete(queued.commandId);
          setEcho(
            ack.ok
              ? { channel: "attach", phase: "acked", commandId: queued.commandId }
              : { channel: "attach", phase: "failed", detail: ack.error, commandId: queued.commandId },
          );
        } else {
          setEcho({ channel: "attach", phase: "sent", commandId: queued.commandId });
        }
        endWait();
        vibrate(10);
        return;
      }
      // auto：409 自动降级（prompt → followUp）；手动模式直接带对应 mode；
      // 图片附件随 prompt 上传（pi 直接附图，claude 走 @path 引用，契约 §1/§11）
      const outcome = await sendPromptWithMode(
        sessionId,
        hintedText,
        sendMode,
        {
          sendPrompt: api.sendPrompt,
          onNotice: setNotice,
        },
        imagePaths.length > 0 ? imagePaths : undefined,
        // 幂等键 = 乐观占位 id：超时重发同键，server 去重防同文双发双执行
        localId,
      );
      if (!outcome.result.accepted) {
        enqueueFailedSend(localId, text, atts, channel, false, "消息未被接受，请稍后重试");
        endWait();
        setNotice("消息未被接受，请稍后重试");
      } else {
        setStatus("running");
        beginWait("thinking");
        markPanelDriven();
        // 发送成功触觉反馈（不支持的平台静默降级）
        vibrate(10);
      }
    } catch (e) {
      // duck-type 读错误码（测试 mock 的 client 模块未必导出 ApiError 类）
      const rawCode = (e as { code?: unknown } | null)?.code;
      const code = typeof rawCode === "string" ? rawCode : null;
      if (code === "ATTACH_ACTIVE" || code === "ATTACH_REQUIRED") {
        // 双模式跨设备死锁自愈（server 是事实源）：通道与 server 接管态对齐后自动补发
        // （同 localId 幂等），不再入手动重试死信；提示告知现状与出路
        const healChannel: "parallel" | "attach" = code === "ATTACH_ACTIVE" ? "attach" : "parallel";
        applyAttachMode(healChannel);
        enqueueFailedSend(
          localId,
          text,
          atts,
          healChannel,
          true,
          code === "ATTACH_ACTIVE" ? "终端接管中，消息已改发往电脑终端" : "终端未接管，消息已改由 server 处理",
        );
        setNotice(
          code === "ATTACH_ACTIVE"
            ? "🖥 终端接管中：已自动切到 🖥 接管模式，消息改由电脑终端 pi 执行（如需手机平行发送，请在电脑终端退出接管）"
            : "终端已退出接管：已自动切回 📱 平行模式，消息由 server 的 pi 继续处理",
        );
        endWait();
        void flushOfflineQueue({ notify: true });
        return;
      }
      // 网络错误 / 5xx → 自动重试；4xx 业务拒绝 → 手动重试（均持久化，刷新不丢）
      const message = e instanceof Error ? e.message : "发送失败";
      enqueueFailedSend(localId, text, atts, channel, classifySendError(e) === "network", message);
      endWait();
      setNotice(message);
    }
  };

  const doSend = async () => {
    // 同步防重入：React state 未 flush 的极速双击/多通道触发也只发一条（快速双击 bug）
    if (sendingRef.current) return;
    const raw = inputRef.current.trim();
    // 附件兜底：正文为空但仍有附件时用引用行；引用回复拼 Markdown 引用块（`> `）
    const base = buildSendText(raw, attachments);
    const text = quote ? withQuote(quote.text, base) : base;
    if (!text) return;
    sendingRef.current = true;
    forceScrollRef.current = true; // 发送即强制回底：用户必须看到自己刚发的消息
    const sent = attachments;
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
    clearDraftNow();
    setAttachments([]);
    setQuote(null);
    try {
      await performSend(localId, text, sent);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** 发送失败重试：从持久队列原样重发（不新增占位）；成功出队（F1） */
  const retrySend = async (localId: string) => {
    if (sendingRef.current) return;
    const item = queuedById.get(localId);
    if (!item) return;
    sendingRef.current = true;
    forceScrollRef.current = true; // 重试同口径：用户意图同样在最新处
    setSending(true);
    setNotice(null);
    beginWait("sending");
    try {
      const result = await flushOfflineQueue({ only: [localId] });
      const failure = result?.failed.find((f) => f.localId === localId);
      if (!failure && result?.sent.includes(localId)) {
        if (item.channel === "attach") {
          setEcho({ channel: "attach", phase: "sent", commandId: localId });
          endWait();
        } else {
          setStatus("running");
          beginWait("thinking");
          markPanelDriven();
        }
        vibrate(10);
      } else {
        endWait();
        setNotice(failure?.error ?? "发送失败，仍在等待重试");
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** 丢弃待发送消息（业务拒绝的坏消息手动清掉） */
  const discardQueued = (localId: string) => {
    getOfflineQueue().remove(localId);
    showToast("已删除待发送消息");
  };

  /** 待发送队列全部重发 */
  const retryAll = async () => {
    setNotice(null);
    await flushOfflineQueue({ notify: true });
  };

  /** 网络恢复（online 事件）/ WS 重连：离线队列自动按序补发（F1） */
  const flushQueueNow = useCallback((notify: boolean) => {
    if (getOfflineQueue().list().length === 0) return;
    void flushOfflineQueue({ notify });
  }, []);

  useEffect(() => {
    const onOnline = () => flushQueueNow(true);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushQueueNow]);

  /** 切换会话驱动模式（E3）：attach 先与 server 握手（终端在线才能接管）；detach 恢复平行通道 */
  const changeAttachMode = async (mode: AttachMode) => {
    if (mode === attachModeRef.current) return;
    setAttachBusy(true);
    try {
      if (mode === "attach") {
        const result = await api.attachSession(sessionId);
        setTerminal({ online: result.agent?.online ?? true, attached: true });
        setNotice("已接管终端：消息将发往电脑终端 pi 实时执行");
      } else {
        await api.detachSession(sessionId);
        setTerminal((prev) => (prev ? { ...prev, attached: false } : prev));
        setNotice("已切回 📱 平行模式：消息由 server 的 pi 实例继续处理");
      }
      attachModeRef.current = mode;
      setAttachMode(mode);
      saveAttachMode(safeStorage(), sessionId, mode);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "模式切换失败");
    } finally {
      setAttachBusy(false);
    }
  };

  // 发送归属确认一行小字：6s 后自动收起（零常驻占位）
  useEffect(() => {
    if (!echo) return;
    const timer = setTimeout(() => setEcho(null), 6000);
    return () => clearTimeout(timer);
  }, [echo]);

  /**
   * 面板驱动标识（与驱动来源徽章/预期提示条统一）：手机发消息实际由 server 的 pi SDK 实例干活，
   * 电脑终端里的 pi 进程看不到实时变化。首次发送 toast 提示 + 顶栏 📱 徽章，不阻断操作。
   */
  const markPanelDriven = () => {
    setDrivenBy("panel");
    const storage = safeStorage();
    const key = `agent-hub.panelHint.v1:${sessionId}`;
    if (panelHintShownRef.current || storage?.getItem(key) === "1") return;
    panelHintShownRef.current = true;
    try {
      storage?.setItem(key, "1");
    } catch {
      /* 存储不可用：仅本次会话内提示 */
    }
    showToast("💬 本会话已由面板驱动：电脑端 pi 需重开会话（pi --resume）才能看到这些消息");
  };

  /** 预期提示条“知道了”：关闭并记住（同一会话不再弹） */
  const dismissDriverHint = () => {
    setDriverHint(false);
    try {
      safeStorage()?.setItem(`agent-hub.driverHint.v1:${sessionId}`, "1");
    } catch {
      /* 存储不可用：仅本次会话内关闭 */
    }
  };

  const doAbort = async () => {
    try {
      await api.abortSession(sessionId);
      clearPendingIdle();
      setNotice("已发送中止请求");
      setSending(false);
      setStatus("idle");
      endWait();
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

  /** ↓ 新消息浮标：回到底部（清零计数并恢复跟随）；平滑滚动尊重 prefers-reduced-motion */
  const scrollToBottom = () => {
    setNewCount(0);
    bottomRef.current?.scrollIntoView?.({ behavior: scrollBehaviorOf(window), block: "end" });
    // E2 起跟随判定为几何口径（贴底 <160px 自动跟随）：滚到底即恢复跟随，无需 ref
  };

  // 输入框自增高：内容变化时 1 行起随内容增高，上限 6 行（超出内部滚动）
  useLayoutEffect(() => {
    const el = inputWrapRef.current?.querySelector("textarea");
    if (el) autoGrowTextarea(el);
  }, [input]);

  // 键盘弹出（visualViewport 收缩）时保持贴底跟随，消息区不被压出可视区
  useEffect(() => {
    if (kbInset > 0) {
      const el = scrollRef.current;
      const nearBottom = el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (nearBottom) bottomRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [kbInset]);

  /** 长按菜单"引用"（引用回复条）：handler 保持稳定，配合 MessageBubble 的 React.memo */
  const handleQuote = useCallback((msg: SessionMessage) => {
    setQuote({ text: msg.text });
  }, []);

  /** 同会话并行流式回合序号（sub agent 并行时多个回合同时进行）：气泡带 🔗 标记 */
  const liveRanks = useMemo(() => {
    const ranks = new Map<string, { index: number; total: number }>();
    const liveIds = messages.filter((m) => m.streaming === true && m.role === "assistant").map((m) => m.id);
    liveIds.forEach((id, i) => ranks.set(id, { index: i + 1, total: liveIds.length }));
    return ranks;
  }, [messages]);

  // i1 空间回收：modebar 仅活动期显示（running/等待/子代理/离线队列/断线），空闲态零占位，
  // 发送模式入口移到输入按钮行（功能不丢，只是换个位置）
  const modebarActive =
    status === "running" || wait !== null || subAgents.length > 0 || sessionQueue.length > 0 || !connected;

  return (
    <div className="chat-page" style={{ "--kb-inset": `${kbInset}px` } as CSSProperties}>
      <header className="chat-header">
        {/* J1 统一图标按钮规范（.icon-btn）：返回/树/git/⋯/模式切换/中止同一套盒子 */}
        <button
          type="button"
          className="icon-btn back"
          onClick={() => navigate(chatReturnPath())}
          aria-label="返回列表"
          title="返回列表"
        >
          <BackIcon />
        </button>
        <div className="chat-title">
          <div className="name">{session?.name ?? sessionId}</div>
          <div className="cwd">{session?.cwd ?? ""}</div>
        </div>
        {/* i1 头部收纳：git 状态并入顶栏图标按钮（完整 chips 进 Git 面板），不再占一行 subbar */}
        {session && (
          <button
            type="button"
            className="icon-btn chat-git-btn"
            onClick={() => { setGitFile(null); setGitOpen(true); }}
            aria-label="查看 git 变更"
            title="仓库状态与变更"
          >
            <GitBranchIcon />
            <span className={`chat-git-dot${(gitStatus?.dirty.length ?? 0) > 0 ? " dirty" : ""}`} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn chat-tree-btn"
          onClick={() => navigate(treePath(sessionId))}
          aria-label="查看会话分支树"
          title="查看会话分支树"
        >
          <TreeIcon />
        </button>
        {/* 右侧徽章簇（一行不换行）：状态/驱动/模式/⋯；次要信息（cwd/来源/子代理）收进 ⋯ 菜单 */}
        <div className="chat-badges">
          {/* 子代理来源标记：信息收进 ⋯ 菜单（i1），避免顶栏换行挤压消息区 */}
          <DrivenBadge drivenBy={drivenBy} />
          {/* J1 去「运行中」：running 态顶栏不再显示文字徽章（WaitStageBar 阶段状态已表达运行态，
              信息冗余）；空闲/错误保留，模式区分图标（AttachModeMenu）保留 */}
          {status !== "running" && <StatusBadge status={status} />}
          {/* 双模式切换（E3）：顶栏一个紧凑徽章，弹出小菜单二选一，零额外常驻占位 */}
          <AttachModeMenu
            mode={attachMode}
            terminal={terminal}
            busy={attachBusy}
            onChange={(m) => void changeAttachMode(m)}
          />
          <SessionActionsMenu
            onFork={() => void doFork()}
            forkBusy={forkBusy}
            onRename={() => setRenameOpen(true)}
            info={{
              cwd: session?.cwd ?? null,
              source: session?.source ?? null,
              drivenBy,
              isSubAgent: session?.isSubAgent === true,
            }}
          />
        </div>
      </header>

      {notice && (
        <div className="chat-notice">
          <span className="chat-notice-text">{notice}</span>
          <button type="button" className="chat-notice-close" onClick={() => setNotice(null)} aria-label="关闭提示">
            ✕
          </button>
        </div>
      )}

      {/* 预期提示条（心理预期管理）：面板驱动过的会话首次进入提醒两条工作流，可一键分叉（i1 紧凑单行） */}
      {driverHint && (
        <div className="driver-hint" role="note" aria-label="驱动来源提示">
          <span className="driver-hint-text" title="此会话由手机面板继续过——电脑端 pi 需重开会话（pi --resume）才能看到这些消息">
            💬 此会话由手机面板继续过——电脑端 pi 需重开会话（pi --resume）才能看到这些消息
          </span>
          <div className="driver-hint-actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void doFork()} disabled={forkBusy}>
              {forkBusy ? "复制中…" : "复制为新会话"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={dismissDriverHint}>
              知道了
            </Button>
          </div>
        </div>
      )}


      <div
        className="chat-messages"
        role="log"
        aria-label="对话消息"
        ref={scrollRef}
        onScroll={handleScroll}
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
          <div className="msg-list" ref={listRef}>
            {virtualized && windowPad > 0 && (
              <div className="msg-window-pad" aria-hidden="true" style={{ height: windowPad }} />
            )}
            {withDateDividers(virtualized ? messages.slice(windowStart) : messages).map((item) =>
              item.kind === "divider" ? (
                <div key={item.id} className="date-divider" role="separator" aria-label={item.label}>
                  <span className="date-divider-label">{item.label}</span>
                </div>
              ) : (
                <MessageBubble
                  key={item.message.id}
                  message={item.message}
                  highlight={item.message.id === highlightId}
                  liveIndex={liveRanks.get(item.message.id)?.index}
                  liveTotal={liveRanks.get(item.message.id)?.total}
                  onOpenFile={setFileRef}
                  onQuote={handleQuote}
                  measureRef={rowMeasureRef}
                  sendFailed={queuedById.has(item.message.id)}
                  sendQueued={queuedById.get(item.message.id)?.autoRetry === true}
                  onRetry={() => void retrySend(item.message.id)}
                />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </PullToRefresh>
      </div>

      {/* ↓ 新消息浮标：上翻历史时不拉扯视口，新到消息累计计数，点击回底部 */}
      {newCount > 0 && (
        <button type="button" className="new-messages-btn" onClick={scrollToBottom}>
          ↓ {newCount} 条新消息
        </button>
      )}

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
        {/* 一行 = 子代理摘要 | 阶段化等待反馈 | 中止（i1：仅活动期渲染；子代理区优先占宽、按钮不换行） */}
        {modebarActive && (
        <div className="composer-modebar">
          <SubAgentPanel
            inline
            agents={subAgents}
            defaultCollapsed
            preferenceKey={`agent-hub.subagentPanel.v1:${sessionId}`}
            onOpenSession={(id) => navigate(chatPath(id))}
          />
          <WaitStageBar
            phase={wait?.phase ?? null}
            startedAt={wait?.startedAt ?? null}
            disconnected={status === "running" && !connected}
          />
          {wait === null && !connected && (
            <div className="typing-indicator">
              <span>连接断开，重连中…（历史消息不会丢）</span>
            </div>
          )}
          {/* 离线队列徽章（F1）：待发送消息数；点击展开逐条重试/删除 */}
          {sessionQueue.length > 0 && (
            <div className="queue-badge-wrap">
              <button
                type="button"
                className="queue-badge"
                onClick={() => setQueueOpen((v) => !v)}
                aria-label={`待发送消息 ${sessionQueue.length} 条`}
              >
                📶 等待发送（{sessionQueue.length}）
              </button>
              {queueOpen && (
                <div className="queue-popover" role="region" aria-label="待发送消息列表">
                  {sessionQueue.map((item) => (
                    <div key={item.localId} className="queue-item">
                      <span className="queue-item-text">{item.text}</span>
                      <button type="button" className="queue-item-retry" onClick={() => void retrySend(item.localId)}>
                        重试
                      </button>
                      <button type="button" className="queue-item-drop" onClick={() => discardQueued(item.localId)}>
                        删除
                      </button>
                    </div>
                  ))}
                  <button type="button" className="queue-flush-all" onClick={() => void retryAll()}>
                    全部重发
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="modebar-right">
            {/* attach 下中止无意义（run 在终端 pi 进程里），隐藏以免误导 */}
            {status === "running" && !isAttachSending(attachMode, terminal) && (
              <button
                type="button"
                className="icon-btn abort-btn"
                onClick={() => void doAbort()}
                aria-label="中止当前任务"
                title="中止当前任务"
              >
                <StopIcon />
              </button>
            )}
          </div>
        </div>
        )}
        {/* 任务生命周期预期（心理预期管理）：任务由 server 进程持有，退出/锁屏不中断（i1 单行紧凑） */}
        {wait !== null && !bgHintDismissed && (
          <div className="bg-hint" role="note" aria-label="任务生命周期说明">
            <span className="bg-hint-text" title="任务在后台继续——退出页面、锁屏都不中断，完成后通知你">
              📌 任务在后台继续，完成后通知你
            </span>
            <span className="bg-hint-boundary" title="server 重启会中断运行中的任务">
              （server 重启会中断）
            </span>
            <button type="button" className="bg-hint-close" onClick={dismissBgHint} aria-label="不再显示任务提示">
              ✕
            </button>
          </div>
        )}
        {/* 发送归属确认一行小字（E3）："已发往终端" / "平行线工作中"；无内容零占位 */}
        <ChannelEcho echo={echo} />
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
          <QuickCommandPanel
            open={quickOpen}
            disabled={sending}
            onInsert={insertQuickCommand}
            onClose={() => setQuickOpen(false)}
            anchorRef={quickTriggerRef}
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
                placeholder="输入消息…（/ 命令，@ 引用，📎 上传）"
                enterKeyHint="enter"
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
                onCompositionEnd={() => {
                  // 输入法候选确认后的短冷却窗内 Enter 不触发发送（中文输入法回车误发防护）
                  compositionCooldownUntilRef.current = Date.now() + COMPOSITION_COOLDOWN_MS;
                }}
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
                    if (quickOpen) {
                      setQuickOpen(false);
                      e.preventDefault();
                      return;
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
                  // Enter 发送（UX 审查 AC4）：中文输入法组合期/组合后短冷却不触发（防误发）；
                  // 触屏默认回车=换行（习惯不推翻），检测到外接物理键盘或非触屏才 Enter 发送
                  const isTouchUI = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
                  const sendOnEnter = shouldSendOnEnter({
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: e.nativeEvent.isComposing === true,
                    compositionCooldownUntil: compositionCooldownUntilRef.current,
                    now: Date.now(),
                    touchUI: isTouchUI,
                    physicalKeyboard: kbTrackerRef.current?.detected === true,
                  });
                  if (sendOnEnter) {
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
              <button
                type="button"
                ref={quickTriggerRef}
                className={`composer-btn quick-trigger${quickOpen ? " open" : ""}`}
                aria-label="快捷指令（常用 prompt 模板）"
                aria-haspopup="dialog"
                aria-expanded={quickOpen}
                title="快捷指令（常用 prompt 模板）"
                disabled={sending}
                onClick={() => setQuickOpen((v) => !v)}
              >
                ⚡
              </button>
              <UploadButton onFiles={(files) => void handleFiles(files)} busy={uploading} />
              <VoiceInputButton
                onTranscript={(text) => updateInput(insertSnippet(inputRef.current, text))}
                disabled={sending}
              />
              {/* i1：发送模式入口从 modebar 移入按钮行（空闲态不占一整行）；弹层向上弹、右对齐 */}
              <SendModeMenu value={sendMode} onChange={setSendMode} />
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

      {/* 重命名会话：保存后 setSession 刷新页头名字（列表页重挂载时拉到新名） */}
      <RenameSessionSheet
        open={renameOpen}
        sessionId={sessionId}
        currentName={session?.name ?? null}
        onClose={() => setRenameOpen(false)}
        onRenamed={(s) => {
          setSession(s);
          setRenameOpen(false);
        }}
      />

      {introOpen && (
        <AttachIntroSheet
          onClose={() => {
            markIntroSeen(safeStorage());
            setIntroOpen(false);
          }}
          onPick={(mode) => {
            markIntroSeen(safeStorage());
            setIntroOpen(false);
            if (mode === "attach") void changeAttachMode("attach");
          }}
        />
      )}

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
