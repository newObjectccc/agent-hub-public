/**
 * CodexAdapter：Codex 会话的 server 适配层（与 pi/claude 平级的第三个会话源）。
 *
 * - 列表/详情：扫描 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（rollout 解析见
 *   codex-rollout.ts）；会话名优先 ~/.codex/session_index.jsonl 的 thread_name
 * - prompt：本地 spawn `codex exec resume <id> --json <text>`（cwd 用会话 cwd），
 *   解析 stdout 流事件 → 契约 WS 广播（codex-stream.ts）
 * - abort：杀掉本进程 spawn 的子进程（SIGTERM → 宽限后 SIGKILL），幂等
 * - createSession：写最小 rollout（仅 session_meta 行；调研结论见方法注释）
 * - forkSession：复制全部分段 rollout 为新 UUID 会话（行内 session_id/id 同步替换，原文件只读）
 *
 * 注：同一会话可跨多个 rollout 分段文件（续写/压缩轮转），列表/详情按 session_id
 * 归并分段（codex-rollout.ts groupCodexSegments），tail 盯最新段。
 *
 * ── 安全约束（硬规则，与 claude.ts 同口径）──────────────────────────────────
 * 1. 只走本地 spawn，不引入任何远程 SDK / 网络驱动；不读取、不记录、不回显任何凭据
 *    （~/.codex/auth.json 绝不读内容，TOKEN 等仅随子进程 env 继承传递，绝不打印）。
 * 2. 不传 `--dangerously-bypass-approvals-and-sandbox` / `--dangerously-bypass-hook-trust`
 *    等任何绕过权限或危险 flag；sandbox/approval 策略继承用户 ~/.codex/config.toml
 *    （与用户在终端跑 codex 同口径，绝不更宽松）。
 * 3. 模型输出的 stderr 只保留尾部截断预览用于错误提示，不落盘。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import type { PromptResult } from "../sessions/hub.js";
import { appendAttachmentHints } from "../uploads.js";
import { decidePromptAction, parsePromptMode } from "../sessions/prompt-policy.js";
import { inferExternalStatus } from "../sessions/tail.js";
import type { MessageDto, PromptImageAttachment, ServerEvent, SessionListItem, SessionStatus } from "../types.js";
import { CodexStreamTranslator } from "./codex-stream.js";
import {
  buildCodexNewRollout,
  buildSessionIndexLine,
  loadCodexSessionIndex,
  loadCodexSessionMessagesForFiles,
  rewriteCodexRolloutIds,
  scanCodexSessions,
  type CodexFileCacheEntry,
} from "./codex-rollout.js";
import type { SessionAdapter } from "./types.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;

export interface CodexAdapterOptions {
  /** ~/.codex/sessions（rollout 会话文件树） */
  sessionsDir: string;
  /** ~/.codex/session_index.jsonl（id → thread_name 会话名索引） */
  sessionIndexFile: string;
  emit: EmitFn;
  /** 可注入（测试伪造 spawn） */
  spawnFn?: typeof spawn;
  codexBin?: string;
  /** fileCache LRU 上限（缺省 FILE_CACHE_MAX，测试注入小值） */
  fileCacheMax?: number;
}

/** stderr 预览上限（错误提示用） */
const STDERR_PREVIEW_LIMIT = 500;
/** abort 后 SIGTERM → SIGKILL 宽限时间 */
const KILL_GRACE_MS = 2_000;
/** fileCache LRU 上限（audit P2-4）：数百个 rollout 文件快照不无上界驻留 */
export const FILE_CACHE_MAX = 500;

/**
 * LRU Map（audit P2-4）：get 刷新位次、set 逐出最久未用（Map 插入序 = 使用序）。
 * 作为 `Map<string, CodexFileCacheEntry>` 传给 scanCodexSessions，读写都自动限容。
 */
export class LruMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value); // 命中刷新 LRU 位次（绕过覆写的 set，尺寸不变）
    }
    return value;
  }

  set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value); // 逐出最久未用
    }
    return this;
  }
}

interface RunningRun {
  child: ChildProcess;
  translator: CodexStreamTranslator;
  stderrTail: string;
  sessionFile: string;
  /** abort 后不再发 agent_settled 兜底（abort 已发过） */
  aborted: boolean;
}

export class CodexAdapter implements SessionAdapter {
  readonly source = "codex" as const;
  private readonly sessionsDir: string;
  private readonly sessionIndexFile: string;
  private readonly emit: EmitFn;
  private readonly spawnFn: typeof spawn;
  private readonly codexBin: string;
  private readonly running = new Map<string, RunningRun>();
  private readonly queues = new Map<string, string[]>();
  /** 内存运行态（含显式 idle）：带登记时间，超 STATE_TTL 清扫（镜像 hub.ts/claude.ts，audit P2-4） */
  private readonly statuses = new Map<string, { status: SessionStatus; at: number }>();
  private sessionIndex: Map<string, string> | null = null;
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 会话清单 TTL 缓存（listSessions/findSession/loadMessages 共享一次全量解析） */
  private listCache: SessionListItem[] | null = null;
  private listCacheAt = 0;
  private listCacheInflight: Promise<SessionListItem[]> | null = null;
  /** 清单全量扫描次数（测试基准：TTL 内重复查询/并发请求应为 0 新增） */
  private listScans = 0;
  /** 文件级 mtime+size 快照缓存：重扫时不重复 parse 未变 rollout（数百文件防全量读盘）；LRU 限容（audit P2-4） */
  private readonly fileCache: LruMap<string, CodexFileCacheEntry>;
  /** id → 时间序分段文件（同一会话可跨多个 rollout 段，详情/消息全量加载用） */
  private segmentsById = new Map<string, string[]>();
  /** 会话转 live 时回调（用于停掉文件 tail，保持单一推送源） */
  onLive?: (id: string) => void;

  constructor(options: CodexAdapterOptions) {
    this.sessionsDir = options.sessionsDir;
    this.sessionIndexFile = options.sessionIndexFile;
    this.emit = options.emit;
    this.spawnFn = options.spawnFn ?? spawn;
    this.codexBin = options.codexBin ?? "codex";
    const fileCacheMax =
      typeof options.fileCacheMax === "number" && options.fileCacheMax > 0 ? Math.floor(options.fileCacheMax) : FILE_CACHE_MAX;
    this.fileCache = new LruMap<string, CodexFileCacheEntry>(fileCacheMax);
    this.startSweep();
  }

  isLive(id: string): boolean {
    return this.running.has(id);
  }

  getStatus(id: string): SessionStatus {
    return this.statuses.get(id)?.status ?? "idle";
  }

  private statusWithInference(id: string, updatedMs: number): SessionStatus {
    // 本进程状态优先（含显式 idle）：与 sessions/hub.ts 同口径——刚创建/刚 settled 的
    // 文件 mtime 必然新鲜，丢弃 idle 走时间推断会误判 running 60s（新会话显示「思考中」）
    const own = this.statuses.get(id)?.status;
    if (own) return own;
    return inferExternalStatus(updatedMs);
  }

  private setStatus(id: string, status: SessionStatus): void {
    if (this.getStatus(id) === status) return;
    this.dispatch(id, { type: "status", status });
  }

  /** 统一出口：status 事件回写内存状态（含 translator 直发的），保证 getStatus 不漂移 */
  private dispatch(id: string, event: ServerEvent): void {
    if (event.type === "status") this.statuses.set(id, { status: event.status, at: Date.now() });
    this.emit(id, event);
  }

  /** statuses 过期 TTL（镜像 hub.ts/claude.ts STATE_TTL，audit P2-4）：条目只写不清会让外部写盘永久被压制 */
  static readonly STATE_TTL_MS = 30 * 60_000;

  /**
   * 周期清扫（镜像 hub.ts sweep）：statuses 过期条目清理（idle 同样走 TTL——随时清会让
   * 刚创建/刚 settled 的会话回落时间推断误判 running）。TTL 过期后无本进程记录，状态随
   * 文件 mtime 老化自愈。
   */
  sweep(now = Date.now()): void {
    for (const [id, entry] of [...this.statuses]) {
      if (now - entry.at > CodexAdapter.STATE_TTL_MS) this.statuses.delete(id);
    }
  }

  /** 启动周期清扫（30s，unref）；测试可直接调 sweep */
  private startSweep(intervalMs = 30_000): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  private async getIndex(): Promise<Map<string, string>> {
    if (!this.sessionIndex) {
      this.sessionIndex = await loadCodexSessionIndex(this.sessionIndexFile);
    }
    return this.sessionIndex;
  }

  /** 会话清单缓存 TTL：外部新会话最多晚 5s 可见；写路径 invalidate 立即可见（镜像 ClaudeAdapter） */
  static readonly LIST_TTL_MS = 5_000;

  /** 清单全量扫描次数（基准验证用） */
  get scanCount(): number {
    return this.listScans;
  }

  /** fileCache 当前驻留数（测试/诊断：LRU 上限验证，audit P2-4） */
  get fileCacheSize(): number {
    return this.fileCache.size;
  }

  /**
   * 会话清单（TTL 缓存 + 并发 inflight 去重）：
   * findSession 每次调用、GET /api/sessions/:id 一次请求内多次查找共享一次扫描；
   * 扫描内部还有文件级 mtime 快照缓存（codex 会话文件可达数百个）。
   */
  listSessions(): Promise<SessionListItem[]> {
    const now = Date.now();
    if (this.listCache !== null && now - this.listCacheAt < CodexAdapter.LIST_TTL_MS) {
      return Promise.resolve(this.listCache);
    }
    if (this.listCacheInflight !== null) return this.listCacheInflight;
    this.listScans += 1;
    this.listCacheInflight = this.scanSessionsUncached()
      .then((items) => {
        this.listCache = items;
        this.listCacheAt = Date.now();
        return items;
      })
      .finally(() => {
        this.listCacheInflight = null;
      });
    return this.listCacheInflight;
  }

  private async scanSessionsUncached(): Promise<SessionListItem[]> {
    const index = await this.getIndex();
    const { items, segments } = await scanCodexSessions(this.sessionsDir, index, {
      statusOf: (id, updatedMs) => this.statusWithInference(id, updatedMs),
      cache: this.fileCache,
    });
    this.segmentsById = segments;
    return items;
  }

  async findSession(id: string): Promise<SessionListItem | null> {
    return this.listSessions().then((all) => {
      const hit = all.find((item) => item.id === id);
      // status 查询时重算（缓存里是扫描时刻值；与 sessions/hub.ts findSession 同口径）
      return hit ? { ...hit, status: this.statusWithInference(hit.id, Date.parse(hit.updatedAt)) } : null;
    });
  }

  /** 写盘后失效清单缓存（新建/fork 立即可见，不等 TTL；其余场景靠 TTL 失效） */
  private invalidateList(): void {
    this.listCache = null;
    this.listCacheAt = 0;
  }

  async loadMessages(id: string): Promise<MessageDto[] | null> {
    const found = await this.findSession(id);
    if (!found) return null;
    // 分段会话按时间序归并全部段（段内只含新增轮次），单段会话退化为单文件
    return loadCodexSessionMessagesForFiles(this.segmentsById.get(id) ?? [found.sessionFile]);
  }

  /**
   * 新建 codex 会话：写最小 rollout 会话文件（新 UUID + 仅一条 session_meta 行）。
   *
   * ── 调研结论（2026-10-09 实测 codex-cli 0.143）────────────────────────────
   * `codex exec` 起新会话由 CLI 自己生成 session id，server 无法预先得知（列表/跳转
   * 需要），且依赖模型服务可用（实测本机模型不可用时直接失败，会话残缺）。对合成
   * 最小 rollout 的 `codex exec resume <id> --json` 实测：thread.started 带该 id，
   * 会话被正常识别并继续追加（与 CLI 自建会话行为一致）。故「新建」= 落盘最小
   * rollout（比 spawn 起会话更稳：不依赖网络/模型，幂等快），首条消息走既有
   * `codex exec resume <id>` 流程，无需特例。
   */
  async createSession(cwd: string, name?: string): Promise<SessionListItem> {
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_CWD, "cwd 必须是非空绝对路径");
    }
    let isDir = false;
    try {
      isDir = (await stat(cwd)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new HubError(ErrorCodes.INVALID_CWD, `cwd 不存在或不是目录: ${cwd}`);
    }
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const file = this.rolloutFilePath(sessionId, new Date());
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, buildCodexNewRollout({ sessionId, cwd, timestamp }), { flag: "wx" });
    if (trimmedName !== "") {
      // name 事实源是 session_index.jsonl（解析层优先取 thread_name），登记一行
      await appendFile(this.sessionIndexFile, buildSessionIndexLine(sessionId, trimmedName, timestamp), "utf8");
      (await this.getIndex()).set(sessionId, trimmedName);
    }
    // 显式登记 idle：新文件 mtime=now，不登记会被时间推断误判 running 60s
    this.statuses.set(sessionId, { status: "idle", at: Date.now() });
    this.invalidateList();
    return {
      id: sessionId,
      source: "codex",
      name: trimmedName === "" ? null : trimmedName,
      cwd,
      updatedAt: timestamp,
      messageCount: 0,
      isSubAgent: false,
      status: "idle",
      lastUserMessage: null,
      lastAssistantMessage: null,
      sessionFile: file,
    };
  }

  /** rollout 文件路径：~/.codex/sessions/YYYY/MM/DD/rollout-<ISO 本地时间>-<uuid>.jsonl（与 codex 同布局） */
  private rolloutFilePath(sessionId: string, when: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp =
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
      `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
    const dateDir = join(String(when.getFullYear()), pad(when.getMonth() + 1), pad(when.getDate()));
    return join(this.sessionsDir, dateDir, `rollout-${stamp}-${sessionId}.jsonl`);
  }

  /**
   * 复制会话（fork）：把全部分段 rollout 复制为新 UUID 的独立会话文件（分段会话逐段
   * 复制，全量历史归新会话），消息历史/cwd 全部继承；行内 session 标识（session_id/id/
   * thread_id 值 === 旧 id）同步替换为新 id（call_id 等其它 id 保留，保证历史可解析）。
   * 原会话文件只读不写；新文件 `wx` 写入（防覆盖），多段时用 _<uuid> 后缀消歧（与
   * codex 自身的分段命名同形，扫描层会按 session_id 重新归并）。
   */
  async forkSession(id: string): Promise<SessionListItem> {
    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    const newId = randomUUID();
    const sources = this.segmentsById.get(found.id) ?? [found.sessionFile];
    for (const [k, srcFile] of sources.entries()) {
      const content = await readFile(srcFile, "utf8");
      const out = rewriteCodexRolloutIds(content, found.id, newId);
      // 文件名沿用原段的时间戳段（`rollout-<ts>-<uuid>` 取 <ts>），换新 id；多段后续段加 _<uuid> 后缀
      const base = srcFile.split("/").pop() ?? "";
      const main = base.replace(/\.jsonl$/i, "").replace(/^rollout-/, "").split("_")[0];
      const stamp = main.length > 37 ? main.slice(0, main.length - 37) : `segment-${k}`;
      const suffix = k > 0 ? `_${randomUUID()}` : "";
      const file = join(dirname(srcFile), `rollout-${stamp}-${newId}${suffix}.jsonl`);
      await writeFile(file, out, { flag: "wx" });
    }
    if (found.name !== null && found.name !== "") {
      const timestamp = new Date().toISOString();
      await appendFile(this.sessionIndexFile, buildSessionIndexLine(newId, found.name, timestamp), "utf8");
      (await this.getIndex()).set(newId, found.name);
    }
    // 显式登记 idle：fork 新文件 mtime=now，不登记会被时间推断误判 running 60s（与 createSession 同根因）
    this.statuses.set(newId, { status: "idle", at: Date.now() });
    this.invalidateList();
    const created = await this.findSession(newId);
    if (!created) {
      throw new HubError(ErrorCodes.INTERNAL, "会话复制后未能读回新会话", 500);
    }
    return created;
  }

  /**
   * 发送消息：
   * - 空闲：spawn `codex exec resume <id> --json <text>`（prompt 作位置参数，help 确认二选一）
   * - 正忙且 mode 缺省/"prompt" → busy（调用方转 409 SESSION_BUSY，与 pi 一致）
   * - 正忙且 steer/followUp → 排队到当前 run 结束（codex exec 无运行中转向能力，保守降级为排队）
   */
  async prompt(id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    const mode = parsePromptMode(modeRaw);
    if (mode === null) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "mode 必须是 prompt|steer|followUp 之一");
    }
    // 图片附件：codex exec 有 -i 图片参数，但上传件存服务端临时目录、path 是原始引用，
    // 与 claude 同口径降级为 @path 引用提示（通道 a），由 codex 的读文件工具自行取图。
    const effectiveText = appendAttachmentHints(text, images);

    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }

    const decision = decidePromptAction(this.running.has(id), mode);
    if (decision.kind === "busy") {
      return { accepted: false, mode: mode ?? "prompt", busy: true };
    }
    if (decision.kind === "steer" || decision.kind === "followUp") {
      const queue = this.queues.get(id) ?? [];
      queue.push(effectiveText);
      this.queues.set(id, queue);
      return { accepted: true, mode: decision.kind };
    }

    this.startRun(found, effectiveText);
    return { accepted: true, mode: "prompt" };
  }

  /** 中止当前运行（幂等）：杀子进程 + 清空排队 */
  async abort(id: string): Promise<void> {
    this.queues.delete(id);
    const run = this.running.get(id);
    if (!run) return;
    run.aborted = true;
    this.killChild(run.child);
    // close 回调负责释放运行态；这里先恢复 UI 可输入
    this.setStatus(id, "idle");
    this.emit(id, { type: "agent_settled" });
  }

  disposeAll(): void {
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const run of this.running.values()) {
      this.killChild(run.child);
    }
    this.running.clear();
    this.queues.clear();
  }

  // ---- 内部 ----

  private killChild(child: ChildProcess): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程已退出
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 忽略
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  /** 合成 user 消息：只发 message_end（translator 跳过 user_message 回显防重复），
   *  前端去重层会把同 role+同 text 的乐观占位（local-*）合并为权威消息，避免重复气泡 */
  private emitUserMessage(id: string, text: string): void {
    this.seq += 1;
    const messageId = `live-user-${this.seq}-${Date.now()}`;
    this.emit(id, {
      type: "message_end",
      message: { id: messageId, role: "user", timestamp: Date.now(), text, toolCalls: [] },
    });
  }

  private seq = 0;

  private startRun(session: SessionListItem, text: string): void {
    if (this.disposed) {
      throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503);
    }
    // spawn 参数固定安全集：不传 --dangerously-bypass-approvals-and-sandbox 等危险 flag
    // （见文件头安全约束）；prompt 作位置参数（resume help：PROMPT 位置参数或 stdin 二选一）
    const args = ["exec", "resume", "--json", session.id, text];
    const child = this.spawnFn(this.codexBin, args, {
      cwd: session.cwd !== "" ? session.cwd : undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    const translator = new CodexStreamTranslator();
    const run: RunningRun = { child, translator, stderrTail: "", sessionFile: session.sessionFile, aborted: false };
    this.running.set(session.id, run);
    this.setStatus(session.id, "running");
    this.onLive?.(session.id);
    this.emitUserMessage(session.id, text);

    let stdoutRest = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutRest += String(chunk);
      let idx = stdoutRest.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutRest.slice(0, idx);
        stdoutRest = stdoutRest.slice(idx + 1);
        for (const event of translator.feed(line)) {
          this.dispatch(session.id, event);
        }
        idx = stdoutRest.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      run.stderrTail = (run.stderrTail + String(chunk)).slice(-STDERR_PREVIEW_LIMIT);
    });

    const finish = (errored: boolean): void => {
      if (this.running.get(session.id) !== run) return; // 已被新 run 顶替
      this.running.delete(session.id);
      // 轮终态事件未到（崩溃/被杀）：flush 未竟消息 + 兜底收尾（abort 已收尾则跳过）
      if (!translator.finished && !run.aborted) {
        for (const event of translator.flush()) {
          this.dispatch(session.id, event);
        }
        this.emit(session.id, { type: "agent_settled" });
        this.setStatus(session.id, errored ? "error" : "idle");
      }
      // translator 已收尾（turn 终态）时：status 由 dispatch 同步，无需重复广播
      // 队列（steer/followUp）依次消费
      const queue = this.queues.get(session.id) ?? [];
      this.queues.delete(session.id);
      const next = queue.shift();
      if (next !== undefined && !this.disposed) {
        if (queue.length > 0) this.queues.set(session.id, queue);
        try {
          this.startRun(session, next);
        } catch {
          this.setStatus(session.id, "error");
        }
      }
    };

    child.on("error", (err: Error) => {
      this.emit(session.id, {
        type: "error",
        code: ErrorCodes.PROMPT_FAILED,
        message: `codex 启动失败: ${err.message}`,
      });
      finish(true);
    });
    child.on("close", (code: number | null) => {
      const failed = code !== 0 && code !== null && !translator.finished && !run.aborted;
      if (failed) {
        const detail = run.stderrTail.trim() !== "" ? run.stderrTail.trim() : `codex 退出码 ${code}`;
        this.emit(session.id, {
          type: "error",
          code: ErrorCodes.PROMPT_FAILED,
          message: `codex 运行失败: ${detail}`,
        });
      }
      finish(failed);
    });
  }
}
