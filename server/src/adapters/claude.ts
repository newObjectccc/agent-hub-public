/**
 * ClaudeAdapter：Claude Code 会话的 server 适配层。
 *
 * - 列表/详情：扫描 ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl（transcript 解析见 claude-transcript.ts）
 * - prompt：本地 spawn `claude -p <text> --resume <session-id> --output-format stream-json …`，
 *   解析 stdout 流事件 → 契约 WS 广播（claude-stream.ts）
 * - abort：杀掉本进程 spawn 的子进程（SIGTERM → 宽限后 SIGKILL），幂等
 * - createSession：写空白 transcript 会话文件（调研结论见方法注释）
 * - forkSession：复制 transcript 为新 UUID 会话文件（行内 sessionId 同步替换，原文件只读）
 * - renameSession：追加 `ai-title` 行（transcript 的会话名栏位，与 claude 自身写名同格式）
 *
 * ── 安全约束（硬规则）─────────────────────────────────────────────────────
 * 1. 只走本地 spawn，不引入任何远程 SDK / 网络驱动；不读取、不记录、不回显任何凭据
 *    （ANTHROPIC_API_KEY 等仅随子进程 env 继承传递，绝不打印）。
 * 2. `--permission-mode manual`：不用用户 settings 里的 bypassPermissions，
 *    保证 claude 无法在无人确认的情况下执行破坏性操作（headless 下需确认的工具一律拒绝）。
 *    不传 `--dangerously-skip-permissions`、不传 `--allowedTools`。
 * 3. 模型输出的 stderr 只保留尾部截断预览用于错误提示，不落盘。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import type { PromptResult } from "../sessions/hub.js";
import { appendAttachmentHints } from "../uploads.js";
import { decidePromptAction, parsePromptMode } from "../sessions/prompt-policy.js";
import { inferExternalStatus } from "../sessions/tail.js";
import type { MessageDto, PromptImageAttachment, ServerEvent, SessionListItem, SessionStatus } from "../types.js";
import { ClaudeStreamTranslator } from "./claude-stream.js";
import {
  claudeSummaries,
  encodeClaudeProjectDir,
  loadClaudeHistoryIndex,
  loadClaudeSessionMessages,
  scanClaudeSessions,
} from "./claude-transcript.js";
import type { SessionAdapter } from "./types.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;

export interface ClaudeAdapterOptions {
  /** ~/.claude/projects */
  projectsDir: string;
  /** ~/.claude/history.jsonl（sessionId → cwd 兜底） */
  historyFile: string;
  emit: EmitFn;
  /** 可注入（测试伪造 spawn） */
  spawnFn?: typeof spawn;
  claudeBin?: string;
}

/** stderr 预览上限（错误提示用） */
const STDERR_PREVIEW_LIMIT = 500;
/** abort 后 SIGTERM → SIGKILL 宽限时间 */
const KILL_GRACE_MS = 2_000;

interface RunningRun {
  child: ChildProcess;
  translator: ClaudeStreamTranslator;
  stderrTail: string;
  sessionFile: string;
  /** abort 后不再发 agent_settled 兜底（abort 已发过） */
  aborted: boolean;
}

export class ClaudeAdapter implements SessionAdapter {
  readonly source = "claude" as const;
  private readonly projectsDir: string;
  private readonly historyFile: string;
  private readonly emit: EmitFn;
  private readonly spawnFn: typeof spawn;
  private readonly claudeBin: string;
  private readonly running = new Map<string, RunningRun>();
  private readonly queues = new Map<string, string[]>();
  private readonly statuses = new Map<string, SessionStatus>();
  private historyIndex: Map<string, string> | null = null;
  private disposed = false;
  /** 会话清单 TTL 缓存（listSessions/findSession/loadMessages 共享一次全量解析） */
  private listCache: SessionListItem[] | null = null;
  private listCacheAt = 0;
  private listCacheInflight: Promise<SessionListItem[]> | null = null;
  /** 清单全量扫描次数（测试基准：TTL 内重复查询/并发请求应为 0 新增） */
  private listScans = 0;
  /** 会话转 live 时回调（用于停掉文件 tail，保持单一推送源） */
  onLive?: (id: string) => void;

  constructor(options: ClaudeAdapterOptions) {
    this.projectsDir = options.projectsDir;
    this.historyFile = options.historyFile;
    this.emit = options.emit;
    this.spawnFn = options.spawnFn ?? spawn;
    this.claudeBin = options.claudeBin ?? "claude";
  }

  isLive(id: string): boolean {
    return this.running.has(id);
  }

  getStatus(id: string): SessionStatus {
    return this.statuses.get(id) ?? "idle";
  }

  private statusWithInference(id: string, updatedMs: number): SessionStatus {
    // 本进程状态优先（含显式 idle）：与 sessions/hub.ts 同口径——刚创建/刚 settled 的
    // 文件 mtime 必然新鲜，丢弃 idle 走时间推断会误判 running 60s（新会话显示「思考中」）
    const own = this.statuses.get(id);
    if (own) return own;
    return inferExternalStatus(updatedMs);
  }

  private setStatus(id: string, status: SessionStatus): void {
    if (this.getStatus(id) === status) return;
    this.dispatch(id, { type: "status", status });
  }

  /** 统一出口：status 事件回写内存状态（含 translator 直发的），保证 getStatus 不漂移 */
  private dispatch(id: string, event: ServerEvent): void {
    if (event.type === "status") this.statuses.set(id, event.status);
    this.emit(id, event);
  }

  private async getHistoryIndex(): Promise<Map<string, string>> {
    if (!this.historyIndex) {
      this.historyIndex = await loadClaudeHistoryIndex(this.historyFile);
    }
    return this.historyIndex;
  }

  /** 会话清单缓存 TTL：外部新会话最多晚 5s 可见；写路径 invalidate 立即可见（镜像 sessions/hub.ts 的 LIST_TTL_MS 方案） */
  static readonly LIST_TTL_MS = 5_000;

  /** 清单全量扫描次数（基准验证用） */
  get scanCount(): number {
    return this.listScans;
  }

  /**
   * 会话清单（TTL 缓存 + 并发 inflight 去重）：
   * findSession 每次调用、GET /api/sessions/:id 一次请求内多次查找共享一次扫描，
   * 不再每次全量 parse 全部 transcript（曾是 claude 侧 CPU/OOM 放大源）。
   */
  listSessions(): Promise<SessionListItem[]> {
    const now = Date.now();
    if (this.listCache !== null && now - this.listCacheAt < ClaudeAdapter.LIST_TTL_MS) {
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
    const history = await this.getHistoryIndex();
    return scanClaudeSessions(this.projectsDir, history, {
      statusOf: (id, updatedMs) => this.statusWithInference(id, updatedMs),
    });
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
    return loadClaudeSessionMessages(found.sessionFile);
  }

  /**
   * 新建 claude 会话：写空白 transcript 会话文件（新 UUID + 一条 isMeta 占位行）。
   *
   * ── 调研结论（2026-09-29 实测 claude 2.1.267）──────────────────────────────
   * claude CLI 没有「预创建会话」命令；新会话原生语义是 `claude -p <text>`（不带
   * --resume）由 CLI 自己生成 session id，server 无法预先得知 id（列表/跳转需要）。
   * 对合成文件的 resume 实测：
   * - 空文件 + `--resume <id>` → `No conversation found with session ID`（失败）
   * - 含一条 isMeta user 占位行的 transcript + `--resume <id>` → 成功，后续消息
   *   append 到同一文件（13 行实测），与 CLI 自建会话行为一致。
   * 故「新建」= 落盘带 isMeta 占位行的空白 transcript（解析后消息数 0，chat 显示
   * 空会话），首条消息走既有 `claude -p --resume <id>` 流程，无需特例。
   * ─────────────────────────────────────────────────────────────────────────
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
    const dir = join(this.projectsDir, encodeClaudeProjectDir(cwd));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    const lines: string[] = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "(new session)" },
        uuid: randomUUID(),
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        isMeta: true,
        userType: "external",
      }),
    ];
    if (trimmedName !== "") {
      lines.push(JSON.stringify({ type: "ai-title", aiTitle: trimmedName, sessionId, cwd, timestamp }));
    }
    await writeFile(file, `${lines.join("\n")}\n`, { flag: "wx" });
    // 显式登记 idle：空会话文件 mtime=now，不登记会被时间推断误判 running 60s
    this.statuses.set(sessionId, "idle");
    this.invalidateList();
    return {
      id: sessionId,
      source: "claude",
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

  /**
   * 复制会话（fork）：把 transcript 复制为新 UUID 的独立会话文件，消息历史/
   * cwd/name 全部继承；行内 `sessionId` 同步替换为新 id（uuid/parentUuid 消息链
   * 保留原值，保证历史可解析）。
   *
   * 实测（claude 2.1.267）：复制 + sessionId 替换后 `claude -p --resume <new-id>`
   * 成功且后续消息 append 到新文件，原文件字节不变（hash 对比）。
   * 原会话文件只读不写；新文件 `wx` 写入（防覆盖）。
   */
  async forkSession(id: string): Promise<SessionListItem> {
    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    const newId = randomUUID();
    const content = await readFile(found.sessionFile, "utf8");
    const outLines: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let row: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) row = parsed as Record<string, unknown>;
      } catch {
        row = null;
      }
      if (row === null) {
        outLines.push(trimmed); // 损坏行原样保留（解析层本就跳过）
        continue;
      }
      if (typeof row.sessionId === "string") row.sessionId = newId;
      outLines.push(JSON.stringify(row));
    }
    const file = join(dirname(found.sessionFile), `${newId}.jsonl`);
    await writeFile(file, `${outLines.join("\n")}\n`, { flag: "wx" });
    // 显式登记 idle：fork 新文件 mtime=now，不登记会被时间推断误判 running 60s
    // （与 createSession 同根因：fork 后进 chat 页即显示「思考中」+ 停止按钮）
    this.statuses.set(newId, "idle");
    this.invalidateList();
    const created = await this.findSession(newId);
    if (!created) {
      throw new HubError(ErrorCodes.INTERNAL, "会话复制后未能读回新会话", 500);
    }
    return created;
  }

  /**
   * 重命名会话（claude）：transcript 的 `ai-title` 行（aiTitle 字段）是会话名栏位
   * （claude-transcript.ts 解析口径：最新一条为当前名，显式空串 = 清空），这里追加一行
   * 同格式记录（append-only，与 claude 自身写名行为一致，原行不改不删）。
   *
   * ⚠️ mtime 陷阱（与 createSession/forkSession 同根因）：写盘会把文件 mtime 刷成 now，
   * 不登记会被 inferExternalStatus 的 60s 时间窗误判 running（改名后卡片/聊天页显示
   * 「工作中」）。这里把**改名瞬间的推断状态快照**显式登记进 statuses（不改变真实状态）；
   * 快照为 running 且本进程无记录时不落登记（外部活动真实推断，保留 mtime 老化自愈）。
   */
  async renameSession(id: string, name: string): Promise<SessionListItem> {
    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    // 快照必须在写盘前取：写盘后 mtime=now 必然推断成 running，快照就失去意义
    const hadOwn = this.statuses.has(id);
    const snapshot = this.statusWithInference(id, Date.parse(found.updatedAt));
    const trimmed = typeof name === "string" ? name.replace(/[\r\n]+/g, " ").trim() : "";
    const timestamp = new Date().toISOString();
    await appendFile(
      found.sessionFile,
      JSON.stringify({ type: "ai-title", aiTitle: trimmed, sessionId: id, cwd: found.cwd, timestamp }) + "\n",
      "utf8",
    );
    if (hadOwn || snapshot !== "running") {
      this.statuses.set(id, snapshot);
    }
    // 失效清单缓存：改名立即可见（否则 TTL 窗口内列表/详情还是旧名）
    this.invalidateList();
    const updated = await this.findSession(id);
    if (!updated) {
      throw new HubError(ErrorCodes.INTERNAL, "改名后未能读回会话", 500);
    }
    return updated;
  }

  /**
   * 发送消息：
   * - 空闲：spawn `claude -p <text> --resume <id> --output-format stream-json …`
   * - 正忙且 mode 缺省/"prompt" → busy（调用方转 409 SESSION_BUSY，与 pi 一致）
   * - 正忙且 steer/followUp → 排队到当前 run 结束（claude CLI 无运行中转向能力，保守降级为排队）
   */
  async prompt(id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    const mode = parsePromptMode(modeRaw);
    if (mode === null) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "mode 必须是 prompt|steer|followUp 之一");
    }
    // 图片附件：claude CLI 只有文本通道（spawn `claude -p <text>`），无 ImageContent 通道；
    // 降级为 @path 引用提示（通道 a），由 claude 的 Read 工具读图（见 uploads.ts 调研结论）。
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

  /** 合成 user 消息（-p 模式不回显 prompt）：只发 message_end，
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
    // spawn 参数固定安全集：不加 --dangerously-skip-permissions / --allowedTools；
    // --permission-mode manual 覆盖用户 settings 的 bypassPermissions（见文件头安全约束）
    const args = [
      "-p",
      text,
      "--resume",
      session.id,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "manual",
    ];
    const child = this.spawnFn(this.claudeBin, args, {
      cwd: session.cwd !== "" ? session.cwd : undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    const translator = new ClaudeStreamTranslator();
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
      // result 事件未到（崩溃/被杀）：flush 未竟消息 + 兜底收尾（abort 已收尾则跳过）
      if (!translator.finished && !run.aborted) {
        for (const event of translator.flush()) {
          this.dispatch(session.id, event);
        }
        this.emit(session.id, { type: "agent_settled" });
        this.setStatus(session.id, errored ? "error" : "idle");
      }
      // translator 已收尾（result）时：status 由 dispatch 同步，无需重复广播
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
        message: `claude 启动失败: ${err.message}`,
      });
      finish(true);
    });
    child.on("close", (code: number | null) => {
      const failed = code !== 0 && code !== null && !translator.finished && !run.aborted;
      if (failed) {
        const detail = run.stderrTail.trim() !== "" ? run.stderrTail.trim() : `claude 退出码 ${code}`;
        this.emit(session.id, {
          type: "error",
          code: ErrorCodes.PROMPT_FAILED,
          message: `claude 运行失败: ${detail}`,
        });
      }
      finish(failed);
    });
  }
}
