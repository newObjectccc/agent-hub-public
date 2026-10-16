/**
 * 离线消息队列（F1）：手机弱网/断网发消息不丢。
 *
 * - 发送失败（网络错误）→ 消息进本地持久队列（localStorage，刷新/杀 App 不丢），
 *   UI 标「📶 等待发送（N）」；网络恢复（online / WS 重连）自动按序重发，成功出队。
 * - 与旧"发送失败重试"（failedSends）融合：failedSends 升级为本持久队列——
 *   业务拒绝（4xx/未接受）标手动重试（autoRetry=false），网络错误标自动重试。
 * - 附件/图片随消息入队：已上传的存引用路径；未上传的存 base64，恢复网络补上传后发消息。
 *   base64 持久化有体积上限（单图 1MB / 队列 3MB），超限保留内存态并提示（不静默丢）。
 * - 按序语义：队列顺序 = 发送顺序；网络类失败中止本轮 flush（保留顺序），业务类失败
 *   标记后继续（不让一条坏消息堵死整条队列）。
 */
import type { PromptResult, SessionSource } from "../api/types";
import type { PromptMode } from "../api/client";
import type { Attachment } from "../utils/uploads";
import type { SendMode } from "../api/prompt";

export const OFFLINE_QUEUE_KEY = "agent-hub.offlineQueue.v1";
/** 单张未上传图片 base64 持久化上限（≈1MB，压缩前原图请联网后发送） */
export const MAX_QUEUE_IMAGE_BASE64 = 1024 * 1024;
/** 队列持久化总量上限（localStorage 与其它 key 共享 ~5MB） */
export const MAX_QUEUE_BYTES = 3 * 1024 * 1024;

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 队列里的附件/图片：已上传存 path，未上传存 base64（联网后补上传） */
export interface QueuedImage {
  name: string;
  mimeType: string;
  isImage: boolean;
  /** 已上传：server 引用路径（相对会话 cwd 或绝对） */
  path: string | null;
  /** 未上传：纯 base64（不含 data: 前缀） */
  data: string | null;
}

export interface QueuedSend {
  /** 乐观占位 id（local-*），兼作幂等键 clientMessageId（attach 指令队列与 parallel prompt 重发同键） */
  localId: string;
  sessionId: string;
  source?: SessionSource;
  /** Codex HTTP 已受理但尚未收到原生回执，刷新后只查询状态，不重发执行。 */
  commandId?: string;
  /** 会话 cwd（附件补上传时直接用，免去 findSession 全量扫描） */
  cwd: string;
  text: string;
  images: QueuedImage[];
  /** parallel 通道的发送模式（auto=409 自动降级；attach 通道入队时已映射） */
  sendMode: SendMode;
  /** 发送模式映射后的指令模式（attach 通道用） */
  attachMode: PromptMode;
  channel: "parallel" | "attach";
  queuedAt: number;
  attempts: number;
  /** true=网络失败自动重试；false=业务拒绝需手动重试 */
  autoRetry: boolean;
  lastError: string | null;
}

export type AddResult = { ok: true } | { ok: false; reason: string };

/** Attachment 草稿 → 队列附件 */
export function queuedImagesOf(attachments: readonly Attachment[]): QueuedImage[] {
  return attachments.map((a) => ({
    name: a.name,
    mimeType: a.mimeType,
    isImage: a.isImage,
    path: a.uploaded === false ? null : a.path,
    data: a.uploaded === false ? (a.data ?? null) : null,
  }));
}

/** 队列附件 → 可预览附件（重试渲染用） */
export function attachmentsOf(item: QueuedSend): Attachment[] {
  return item.images.map((img, i) => ({
    id: `${item.localId}-att-${i}`,
    name: img.name,
    path: img.path ?? "",
    mimeType: img.mimeType,
    size: img.data ? Math.floor((img.data.length * 3) / 4) : 0,
    isImage: img.isImage,
    preview: img.data ? `data:${img.mimeType};base64,${img.data}` : null,
    uploaded: img.path !== null,
    data: img.data,
  }));
}

/** 上传后补附件引用提示（镜像 server appendAttachmentHints 的通道 a 语义） */
export function appendLocalAttachmentHints(text: string, paths: readonly string[]): string {
  const missing = paths.filter((p) => p !== "" && !text.includes(p));
  if (missing.length === 0) return text;
  const lines = missing.map((p) => `[附件] @${p}`);
  const base = text.trimEnd();
  return base === "" ? lines.join("\n") : `${base}\n\n${lines.join("\n")}`;
}

/** 队列 JSON 解析（损坏/缺字段一律空队列，绝不 throw） */
export function parseQueue(raw: string): QueuedSend[] {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; items?: unknown };
    if (!parsed || !Array.isArray(parsed.items)) return [];
    const out: QueuedSend[] = [];
    for (const entry of parsed.items) {
      const item = entry as Partial<QueuedSend>;
      if (!item || typeof item.localId !== "string" || item.localId === "") continue;
      if (typeof item.sessionId !== "string" || item.sessionId === "") continue;
      if (typeof item.text !== "string") continue;
      const images = Array.isArray(item.images)
        ? item.images
            .filter((img): img is QueuedImage => {
              const candidate = img as QueuedImage | null;
              return (
                !!candidate &&
                typeof candidate.name === "string" &&
                typeof candidate.mimeType === "string" &&
                (typeof candidate.path === "string" || typeof candidate.data === "string")
              );
            })
            .map((img) => ({
              name: img.name,
              mimeType: img.mimeType,
              isImage: img.isImage !== false,
              path: typeof img.path === "string" && img.path !== "" ? img.path : null,
              data: typeof img.data === "string" && img.data !== "" ? img.data : null,
            }))
        : [];
      out.push({
        localId: item.localId,
        sessionId: item.sessionId,
        ...(item.source === "pi" || item.source === "claude" || item.source === "codex" ? { source: item.source } : {}),
        ...(typeof item.commandId === "string" && item.commandId.length <= 160 ? { commandId: item.commandId } : {}),
        cwd: typeof item.cwd === "string" ? item.cwd : "",
        text: item.text,
        images,
        sendMode: item.sendMode === "prompt" || item.sendMode === "steer" || item.sendMode === "followUp" ? item.sendMode : "auto",
        attachMode: item.attachMode === "steer" || item.attachMode === "followUp" ? item.attachMode : "prompt",
        channel: item.channel === "attach" ? "attach" : "parallel",
        queuedAt: typeof item.queuedAt === "number" ? item.queuedAt : 0,
        attempts: typeof item.attempts === "number" && item.attempts >= 0 ? Math.floor(item.attempts) : 0,
        autoRetry: item.autoRetry !== false,
        lastError: typeof item.lastError === "string" ? item.lastError : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeQueue(items: readonly QueuedSend[]): string {
  return JSON.stringify({ version: 1, items });
}

export function queueBytes(items: readonly QueuedSend[]): number {
  return new TextEncoder().encode(serializeQueue(items)).length;
}

/** 单条持久化体检：超限原因（null=可持久化） */
export function persistProblem(items: readonly QueuedSend[]): string | null {
  for (const item of items) {
    for (const img of item.images) {
      if (img.data !== null && img.data.length > MAX_QUEUE_IMAGE_BASE64) {
        return `图片「${img.name}」超过离线暂存上限 1MB，该消息仅保留在当前页面（刷新会丢失），请联网后尽快发送`;
      }
    }
  }
  if (queueBytes(items) > MAX_QUEUE_BYTES) {
    return "离线队列已满（3MB 上限），该消息仅保留在当前页面（刷新会丢失），请先发送或删除部分待发消息";
  }
  return null;
}

/** 发送错误分类：网络/5xx → 自动重试；4xx 业务错误 → 手动重试 */
/**
 * 语义上是“稍后重试就会好”且重发幂等安全的业务码 → 归入自动重试。
 *
 * PROMPT_IN_FLIGHT：同 clientMessageId 的上一次提交还在处理中（server 不再伪报 accepted）。
 * 归为 business 会变成手动重试死信，而它本来就只需要等一等；幂等键（localId）保证
 * 重试不会双执行。
 */
const RETRYABLE_BUSINESS_CODES: ReadonlySet<string> = new Set(["PROMPT_IN_FLIGHT"]);

export function classifySendError(e: unknown): "network" | "business" {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && RETRYABLE_BUSINESS_CODES.has(code)) return "network";
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 ? "network" : "business";
  return "network";
}

/**
 * 持久队列：内存 + localStorage 双写（存储不可用/超限时退化为仅内存，不静默丢）。
 * list() 返回稳定引用（配合 useSyncExternalStore）。
 */
export class OfflineQueueStore {
  private items: QueuedSend[] = [];
  private listeners = new Set<() => void>();
  private attachAcks = new Map<string, { ok: boolean; error: string | null }>();

  constructor(private readonly storage: StorageLike | null) {
    try {
      const raw = this.storage?.getItem(OFFLINE_QUEUE_KEY);
      if (raw) this.items = parseQueue(raw);
    } catch {
      this.items = [];
    }
  }

  readonly list = (): readonly QueuedSend[] => this.items;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  pending(sessionId: string): QueuedSend[] {
    return this.items.filter((i) => i.sessionId === sessionId);
  }

  get(localId: string): QueuedSend | null {
    return this.items.find((i) => i.localId === localId) ?? null;
  }

  /** 回执可能先于 HTTP 响应；先缓存，再与持久条目关联。 */
  recordAttachAck(sessionId: string, commandId: string, ok: boolean, error: string | null): void {
    const key = `${sessionId}\0${commandId}`;
    this.attachAcks.set(key, { ok, error });
    while (this.attachAcks.size > 200) this.attachAcks.delete(this.attachAcks.keys().next().value!);
    for (const item of [...this.items]) {
      if (item.sessionId !== sessionId || item.source !== "codex" || item.commandId !== commandId) continue;
      if (ok) this.remove(item.localId);
      else this.patch(item.localId, { commandId: undefined, autoRetry: false, lastError: error ?? "Codex 未确认接收，请核对后重试" });
    }
  }

  trackAttachCommand(localId: string, commandId: string): { ok: boolean; error: string | null } | undefined {
    const item = this.get(localId);
    if (!item) return;
    this.patch(localId, { commandId, autoRetry: false, lastError: null });
    const ack = this.attachAcks.get(`${item.sessionId}\0${commandId}`);
    if (ack) this.recordAttachAck(item.sessionId, commandId, ack.ok, ack.error);
    return ack;
  }

  /** 入队（总在内存；持久化超限时返回原因由调用方提示） */
  add(item: QueuedSend): AddResult {
    this.items = [...this.items.filter((i) => i.localId !== item.localId), item];
    const problem = persistProblem(this.items);
    if (problem) {
      this.notify();
      return { ok: false, reason: problem };
    }
    this.persist();
    return { ok: true };
  }

  patch(localId: string, patch: Partial<QueuedSend>): void {
    let changed = false;
    this.items = this.items.map((i) => {
      if (i.localId !== localId) return i;
      changed = true;
      return { ...i, ...patch };
    });
    if (changed) this.persist();
  }

  remove(localId: string): void {
    const next = this.items.filter((i) => i.localId !== localId);
    if (next.length !== this.items.length) {
      this.items = next;
      this.persist();
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(OFFLINE_QUEUE_KEY, serializeQueue(this.items));
    } catch {
      // 存储不可用/配额满：内存态继续（本次页面内不丢）
    }
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

let singleton: OfflineQueueStore | null = null;

/** 应用级队列单例（页面/离线 flush 共享同一队列） */
export function getOfflineQueue(storage?: StorageLike | null): OfflineQueueStore {
  if (storage !== undefined) {
    singleton = new OfflineQueueStore(storage);
    return singleton;
  }
  if (!singleton) {
    let resolved: StorageLike | null = null;
    try {
      resolved = typeof window === "undefined" ? null : window.localStorage;
    } catch {
      resolved = null;
    }
    singleton = new OfflineQueueStore(resolved);
  }
  return singleton;
}

/* ====================== 队列 flush（按序重发） ====================== */

export interface FlushQueueDeps {
  /** 升级前的持久条目没有来源；生产发送前先补全，避免绕过 Codex 重试边界。 */
  resolveSessionSource?: (id: string) => Promise<SessionSource | null>;
  uploadFile: (
    input: { sessionId?: string; cwd?: string; name: string; mimeType: string; data: string },
    signal?: AbortSignal,
  ) => Promise<{ upload: { path: string } }>;
  sendPrompt: (
    id: string,
    text: string,
    mode: PromptMode,
    images?: string[],
    clientMessageId?: string,
    signal?: AbortSignal,
  ) => Promise<PromptResult>;
  sendPromptWithMode: (
    id: string,
    text: string,
    mode: SendMode,
    deps: { sendPrompt: FlushQueueDeps["sendPrompt"]; onNotice?: (message: string) => void },
    images?: string[],
    clientMessageId?: string,
  ) => Promise<{ result: PromptResult }>;
  sendAttachMessage: (
    id: string,
    text: string,
    mode: PromptMode,
    clientMessageId?: string,
    signal?: AbortSignal,
    images?: string[],
  ) => Promise<{ accepted: boolean; commandId?: string }>;
}

export interface FlushFailure {
  localId: string;
  error: string;
  kind: "network" | "business";
}

export interface FlushResult {
  sent: string[];
  failed: FlushFailure[];
  /** 因网络错误中止（保留顺序，剩余条目原地等待下次 flush） */
  stopped: boolean;
}

export interface FlushOptions {
  /** 只处理指定条目（单条手动重试）；缺省全队列按序 */
  only?: string[];
  /** 单次请求超时（毫秒，防弱网下挂起的 fetch 永久堵死队列）；缺省 20s */
  timeoutMs?: number;
}

/** flush 单请求超时：超时按网络失败处理（保留待发 + 中止本轮，下次 flush 重试）。
 * 取 60s（宽裕）避免“服务端慢响应已完成、客户端却已超时重发”造成重复消息。 */
export const FLUSH_REQUEST_TIMEOUT_MS = 60_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== "undefined" && typeof (AbortSignal as { timeout?: unknown }).timeout === "function"
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 给挂起的请求加看门狗（deps 不理会 signal 也不会永久堵死队列） */
async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("请求超时，请检查网络后重试"), { name: "TimeoutError" })), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 按序重发队列：
 * 1. 未上传附件先补上传（成功即回写队列，重试不重复上传）
 * 2. parallel → sendPromptWithMode（auto 409 降级语义不变）；attach → 指令队列（clientMessageId 幂等）
 * 3. 成功出队；网络失败保留并中止本轮；业务失败保留标手动重试后继续
 */
export async function flushQueue(
  store: OfflineQueueStore,
  deps: FlushQueueDeps,
  options: FlushOptions = {},
): Promise<FlushResult> {
  const result: FlushResult = { sent: [], failed: [], stopped: false };
  const timeoutMs = options.timeoutMs ?? FLUSH_REQUEST_TIMEOUT_MS;
  const targets = options.only
    ? store.list().filter((i) => options.only?.includes(i.localId))
    : store.list().filter((item) => item.source !== "codex" || item.autoRetry);
  const sources = new Map<string, SessionSource | null>();
  for (const stored of targets) {
    let item = stored;
    if (item.source === undefined && deps.resolveSessionSource) {
      try {
        if (!sources.has(item.sessionId)) sources.set(item.sessionId, await withTimeout(deps.resolveSessionSource(item.sessionId), timeoutMs));
        const source = sources.get(item.sessionId);
        if (!source) throw Object.assign(new Error("无法确认旧消息的会话来源，请打开会话核对后重试"), { status: 409 });
        item = { ...item, source };
        store.patch(item.localId, { source, ...(source === "codex" && !options.only ? { autoRetry: false, lastError: "旧消息的执行状态未知，请核对会话后手动重试" } : {}) });
        if (source === "codex" && !options.only) continue;
      } catch (error) {
        const message = error instanceof Error ? error.message : "会话来源尚未确认";
        store.patch(item.localId, { autoRetry: false, lastError: message });
        result.failed.push({ localId: item.localId, kind: "business", error: message });
        continue;
      }
    }
    // 1. 补上传未上传附件（逐个回写，失败不重复上传已成功的）
    let uploadFailed: FlushFailure | null = null;
    const images = [...item.images];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img.path !== null || img.data === null) continue;
      try {
        const { upload } = await withTimeout(
          // 有 cwd 直接用（免 findSession 全量扫描）；无 cwd 退回 sessionId 归属校验
          deps.uploadFile(
            item.cwd !== ""
              ? { cwd: item.cwd, name: img.name, mimeType: img.mimeType, data: img.data }
              : { sessionId: item.sessionId, name: img.name, mimeType: img.mimeType, data: img.data },
            timeoutSignal(timeoutMs),
          ),
          timeoutMs,
        );
        images[i] = { ...img, path: upload.path, data: null };
        store.patch(item.localId, { images });
      } catch (e) {
        const kind = classifySendError(e);
        uploadFailed = { localId: item.localId, error: e instanceof Error ? e.message : "附件上传失败", kind };
        break;
      }
    }
    if (uploadFailed) {
      result.failed.push(uploadFailed);
      store.patch(item.localId, {
        attempts: item.attempts + 1,
        autoRetry: uploadFailed.kind === "network",
        lastError: uploadFailed.error,
      });
      if (uploadFailed.kind === "network") {
        result.stopped = true;
        break;
      }
      continue;
    }

    // 2. 发送（非图片附件补引用提示；图片走 images 参数）；
    //    clientMessageId = localId：超时自动重试同键，server 去重防同文双发双执行
    const nonImagePaths = images.filter((img) => !img.isImage && img.path !== null).map((img) => img.path as string);
    const text = appendLocalAttachmentHints(item.text, nonImagePaths);
    const imagePaths = images.filter((img) => img.isImage && img.path !== null).map((img) => img.path as string);
    /** 单通道发送一次（attach=终端指令队列；parallel=prompt） */
    const sendOnce = async (channel: "parallel" | "attach"): Promise<void> => {
      if (channel === "attach") {
        const accepted = await withTimeout(
          deps.sendAttachMessage(item.sessionId, text, item.attachMode, item.localId, timeoutSignal(timeoutMs), item.source === "codex" ? imagePaths : undefined),
          timeoutMs,
        );
        if (accepted && accepted.accepted === false) {
          throw Object.assign(new Error("终端未接受消息"), { status: 409, code: "ATTACH_REQUIRED" });
        }
        if (item.source === "codex") {
          if (!accepted.commandId) throw Object.assign(new Error("Codex 未返回指令编号，请核对会话后重试"), { status: 409 });
          const ack = store.trackAttachCommand(item.localId, accepted.commandId);
          if (ack?.ok === false) throw Object.assign(new Error(ack.error ?? "Codex 未接收消息"), { status: 409 });
        }
        return;
      }
      const signal = timeoutSignal(timeoutMs);
      const outcome = await withTimeout(
        deps.sendPromptWithMode(
          item.sessionId,
          text,
          item.sendMode,
          {
            sendPrompt: (id, t, mode, imgs, clientMessageId) =>
              deps.sendPrompt(id, t, mode, imgs, clientMessageId ?? item.localId, signal),
          },
          imagePaths.length > 0 ? imagePaths : undefined,
          item.localId,
        ),
        timeoutMs,
      );
      if (!outcome?.result?.accepted) {
        throw Object.assign(new Error("消息未被接受，请重试"), { status: 409 });
      }
    };
    /** 发送（含 409 ATTACH_ACTIVE 死锁自愈：终端接管中 parallel 通道停用 →
     *  通道校正为 attach 后重发一次（同 localId 幂等），入队条目不再永卡死信） */
    const sendWithHeal = async (): Promise<void> => {
      try {
        await sendOnce(item.channel);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (code !== "ATTACH_ACTIVE" || item.channel !== "parallel" || item.source === "codex") throw e;
        store.patch(item.localId, { channel: "attach" });
        await sendOnce("attach");
      }
    };
    try {
      await sendWithHeal();
      if (!(item.source === "codex" && item.channel === "attach")) store.remove(item.localId);
      result.sent.push(item.localId);
    } catch (e) {
      const kind = classifySendError(e);
      const error = e instanceof Error ? e.message : "发送失败";
      result.failed.push({ localId: item.localId, error, kind });
      store.patch(item.localId, { attempts: item.attempts + 1, autoRetry: item.source !== "codex" && kind === "network", lastError: error });
      if (kind === "network") {
        result.stopped = true;
        break;
      }
    }
  }
  return result;
}
