/**
 * 每个接管会话独占一个持有写者锁的 app-server 进程。
 * 不回落 exec、不放宽策略、不读凭据或 shell 初始化文件，也不自动批准请求。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ErrorCodes, HubError } from "../errors.js";
import type { HostRequestDto, HostRequestOutcome, MessageDto, MessageImage, ServerEvent, TerminalAttachInfo, ToolCallDto } from "../types.js";
import {
  APPROVAL_METHODS, approvalItemPreview, buildApprovalResult, buildDriverArgs, buildResumeParams, buildTurnInput,
  codexMessageId, hostRequestPreview, parseDriverMode, safePreview, snapshotRequestedPermissions,
  type CodexApprovalItemPreview, type CodexApprovalPolicy, type CodexApprovalType, type CodexDriverMode, type CodexSandbox, type CodexUserInput,
} from "./codex-host-protocol.js";
import { CodexRpc, CodexRpcError, isRecord, isRpcId, type CodexNotification, type CodexRpcId, type CodexServerRequest } from "./codex-rpc.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;
export interface CodexDriverCommand { id: string; mode: CodexDriverMode }
export interface CodexHostRequestDecision { outcome: "allow" | "deny"; message?: string }
export interface CodexCommandStatus { state: "pending" | "accepted" | "failed"; error: string | null }
export interface CodexDriverSendInput { text: unknown; mode?: unknown; clientMessageId?: unknown; images?: readonly unknown[] }
export interface CodexDriverLinkLike {
  attach(id: string, opts: { cwd: string; sessionFile: string }, now?: number): Promise<{ attached: true; driver: "hub"; mirror: boolean }>;
  detach(id: string): boolean;
  isAttached(id: string, now?: number): boolean;
  isAttaching(id: string): boolean;
  isReleasing?(id: string): boolean;
  isBusy?(id: string): boolean;
  runStatusFor(id: string): "running" | "idle" | "error" | null;
  statusFor(id: string, now?: number): TerminalAttachInfo;
  snapshotFor?(id: string): MessageDto[];
  commandStatusFor?(id: string, commandId: string): CodexCommandStatus | null;
  send(id: string, input: CodexDriverSendInput): CodexDriverCommand;
  abortTurn(id: string): void;
  listHostRequests(id: string): HostRequestDto[];
  respondHostRequest(id: string, requestId: string, decision: CodexHostRequestDecision): boolean;
  isResolvedHostRequest(requestId: string): boolean;
  startSweep(): void;
  disposeAll(): void;
}

export interface CodexDriverCapabilities {
  version: string;
  appServer: boolean;
  writerLock: boolean;
}
export interface CodexPreparationContext {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  spawnFn: typeof spawn;
}
export interface CodexDriverOptions {
  emit: EmitFn;
  codexBin?: string;
  maxConcurrent?: number;
  idleDetachMs?: number;
  externalQuietMs?: number;
  hostRequestTtlMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  writeTimeoutMs?: number;
  interruptTimeoutMs?: number;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandbox;
  spawnFn?: typeof spawn;
  /** 可注入 provider 环境准备；默认仅继承环境，不修改 process.env。 */
  prepareEnv?: (context: CodexPreparationContext) => Promise<NodeJS.ProcessEnv>;
  /** 可注入版本/写者锁能力探测；仅能启动进程不足以证明可安全接管。 */
  probeCapabilities?: (context: CodexPreparationContext) => Promise<CodexDriverCapabilities>;
  statFn?: (path: string) => Promise<{ mtimeMs: number }>;
  /** 同进程并行执行/准备互斥；每个异步阶段前后复核。 */
  parallelBusy?: (id: string) => boolean;
}

interface Command extends CodexDriverCommand {
  text: string;
  input: CodexUserInput[];
  clientMessageId?: string;
  timestamp: number;
  images: MessageImage[];
  delivery: "local" | "sent";
}
interface LiveItem {
  id: string;
  timestamp: number;
  text: string;
  tool: ToolCallDto | null;
  ended: boolean;
}
type BufferedEvent = { kind: "notification"; value: CodexNotification } | { kind: "request"; value: CodexServerRequest };
interface TurnState {
  id: string | null;
  aborted: boolean;
  errorEmitted: boolean;
  accepted: Promise<string>;
  resolveAccepted: (id: string) => void;
  rejectAccepted: (error: Error) => void;
  buffered: BufferedEvent[];
  items: Map<string, LiveItem>;
  approvalPreviews: Map<string, CodexApprovalItemPreview>;
  users: MessageDto[];
  interruptSent: boolean;
  interruptTimer: ReturnType<typeof setTimeout> | null;
}
interface HostRequestEntry {
  id: string;
  nativeId: CodexRpcId;
  type: CodexApprovalType;
  turnId: string;
  permissions: Record<string, unknown>;
  dto: HostRequestDto;
  timer: ReturnType<typeof setTimeout>;
}
interface DriverEntry {
  id: string;
  cwd: string;
  child: ChildProcess;
  rpc: CodexRpc;
  ready: boolean;
  stopped: boolean;
  closed: boolean;
  failed: boolean;
  turn: TurnState | null;
  snapshotTurn: TurnState | null;
  queue: Command[];
  commands: Map<string, Command>;
  hostRequests: Map<string, HostRequestEntry>;
  nativeRequests: Map<string, string>;
  /** null 表示此 nativeId 跨轮复用，无 turnId 的 resolved 通知不能再无歧义关联。 */
  nativeRequestTurns: Map<string, string | null>;
  retiredTurns: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}
interface AttachAttempt {
  controller: AbortController;
  promise: Promise<{ attached: true; driver: "hub"; mirror: boolean }>;
}

const CLIENT_TTL_MS = 10 * 60_000;
const RESOLVED_TTL_MS = 5 * 60_000;
const KILL_GRACE_MS = 2_000;
const MAX_QUEUE = 100;
const MAX_BUFFERED_EVENTS = 1_000;

export class CodexDriverHub implements CodexDriverLinkLike {
  private readonly options: CodexDriverOptions;
  private readonly spawnFn: typeof spawn;
  private readonly drivers = new Map<string, DriverEntry>();
  private readonly attaching = new Map<string, AttachAttempt>();
  private readonly clientSeen = new Map<string, {
    command: CodexDriverCommand;
    at: number;
    ack?: { ok: boolean; error: string | null };
  }>();
  private readonly resolvedHostRequests = new Map<string, number>();
  /** 回执与注入幂等使用相同 TTL/上限；退出接管后仍可只读查询，重启不恢复。 */
  private readonly commandStates = new Map<string, CodexCommandStatus & { at: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private capabilityVerified = false;

  constructor(options: CodexDriverOptions) {
    this.options = options;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  attach(id: string, opts: { cwd: string; sessionFile: string }, now = Date.now()): Promise<{ attached: true; driver: "hub"; mirror: boolean }> {
    this.ensureAlive();
    const pending = this.attaching.get(id);
    if (pending) return pending.promise;
    const existing = this.drivers.get(id);
    if (existing?.ready && !existing.stopped) return Promise.resolve({ attached: true, driver: "hub", mirror: false });
    if (existing) return Promise.reject(unavailable("Codex 写者正在释放，请稍后再接管"));
    const max = this.options.maxConcurrent ?? 3;
    if (new Set([...this.drivers.keys(), ...this.attaching.keys()]).size >= max) {
      return Promise.reject(new HubError(ErrorCodes.DRIVER_LIMIT, `接管进程已达上限（${max}），请先退出其他接管会话`, 409));
    }
    const controller = new AbortController();
    // 异步准备开始前先占名额，同会话重入复用同一准备任务。
    const attempt = { controller } as AttachAttempt;
    this.attaching.set(id, attempt);
    attempt.promise = this.startDriver(id, opts, now, controller).finally(() => {
      if (this.attaching.get(id) === attempt) this.attaching.delete(id);
    });
    return attempt.promise;
  }

  private async startDriver(id: string, opts: { cwd: string; sessionFile: string }, now: number, controller: AbortController): Promise<{ attached: true; driver: "hub"; mirror: boolean }> {
    let entry: DriverEntry | undefined;
    const deadline = setTimeout(() => controller.abort(unavailable("Codex 接管启动超时，请检查版本、配置或必需的 MCP 服务")), this.options.readyTimeoutMs ?? 60_000);
    const check = () => {
      this.ensureAlive();
      throwIfAborted(controller.signal);
      if (this.options.parallelBusy?.(id)) throw new HubError(ErrorCodes.EXTERNAL_ACTIVE, "该 Codex 会话正在准备或执行并行消息，请等待结束后再接管", 409);
    };
    try {
      check();
      await abortable(this.assertExternalQuiet(opts.sessionFile, now), controller.signal);
      check();
      const context: CodexPreparationContext = {
        codexBin: this.options.codexBin ?? "codex", cwd: opts.cwd,
        env: { ...process.env }, signal: controller.signal, spawnFn: this.spawnFn,
      };
      context.env = await abortable(this.options.prepareEnv ? this.options.prepareEnv(context) : Promise.resolve(context.env), controller.signal);
      check();
      const capabilities = await abortable((this.options.probeCapabilities ?? probeCodexCapabilities)(context), controller.signal);
      check();
      if (!capabilities.appServer || !capabilities.writerLock) throw unavailable("该 Codex 版本未通过 app-server 写者互斥能力检查，请配置兼容的 Codex 可执行文件");
      await abortable(this.assertExternalQuiet(opts.sessionFile, Math.max(now, Date.now())), controller.signal);
      check();
      const child = this.spawnFn(context.codexBin, buildDriverArgs(), {
        cwd: opts.cwd || undefined, env: context.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      entry = {
        id, cwd: opts.cwd, child, rpc: undefined as unknown as CodexRpc,
        ready: false, stopped: false, closed: false, failed: false, turn: null, snapshotTurn: null,
        queue: [], commands: new Map(), hostRequests: new Map(), nativeRequests: new Map(), nativeRequestTurns: new Map(), retiredTurns: new Set(),
        idleTimer: null, killTimer: null,
      };
      const current = entry;
      current.rpc = new CodexRpc(child, {
        requestTimeoutMs: this.options.requestTimeoutMs,
        writeTimeoutMs: this.options.writeTimeoutMs,
        onNotification: (notification) => this.handleNotification(current, notification),
        onRequest: (request) => this.handleServerRequest(current, request),
        onFault: (error) => {
          if (error instanceof CodexRpcError && error.code === "PROCESS_CLOSED") current.closed = true;
          this.failEntry(current, error);
        },
      });
      // 持续排空 stderr，但不保留或转发：provider 诊断可能含凭据。
      // 界面仅接收经过截断和脱敏的 RPC 错误信息。
      child.stderr?.on("data", () => undefined);
      child.stderr?.on("error", () => undefined);
      child.on("close", () => {
        current.closed = true;
        if (current.killTimer) clearTimeout(current.killTimer);
        current.killTimer = null;
        if (this.drivers.get(id) === current) this.drivers.delete(id);
      });
      this.drivers.set(id, current);
      await abortable(current.rpc.request("initialize", {
        clientInfo: { name: "agent_hub", title: "Agent Hub", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      }), controller.signal);
      check();
      await abortable(current.rpc.notify("initialized"), controller.signal);
      check();
      const result = await abortable(current.rpc.request("thread/resume", buildResumeParams(id, {
        cwd: opts.cwd, approvalPolicy: this.options.approvalPolicy, sandbox: this.options.sandbox,
      })), controller.signal);
      check();
      if (current.stopped) throw unavailable("Codex 接管连接已关闭");
      const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
      if (!thread || thread.id !== id || !isRecord(thread.status)) throw unavailable("Codex thread/resume 返回了不兼容的线程状态");
      if (thread.status.type === "active") throw new HubError(ErrorCodes.SESSION_BUSY, "Codex 会话仍在运行，等待电脑端结束后再接管", 409);
      if (thread.status.type !== "idle") throw unavailable(`Codex 会话当前无法接管（${safePreview(String(thread.status.type), 80)}）`);
      current.ready = true;
      this.capabilityVerified = true;
      this.touchIdle(current);
      this.emit(id, { type: "attach_state", attached: true, terminalOnline: true });
      return { attached: true, driver: "hub", mirror: false };
    } catch (error) {
      if (entry) this.stopEntry(entry, "Codex 接管启动失败", false);
      throw attachError(error);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async assertExternalQuiet(sessionFile: string, now: number): Promise<void> {
    if ((this.options.externalQuietMs ?? 3_000) <= 0) return;
    try {
      const info = await (this.options.statFn ?? stat)(sessionFile);
      if (now - info.mtimeMs < (this.options.externalQuietMs ?? 3_000)) throw unavailable("电脑端正在写入该会话，请稍候再接管");
    } catch (error) {
      if (error instanceof HubError) throw error;
      // 文件不存在或不可读时安全拒绝，不默默取消外部写入保护。
      throw unavailable("无法核对 Codex 会话文件，请刷新会话列表后重试");
    }
  }

  detach(id: string): boolean {
    const pending = this.attaching.get(id);
    if (pending) pending.controller.abort(unavailable("Codex 接管启动已取消"));
    const entry = this.drivers.get(id);
    if (entry) this.stopEntry(entry, "已退出接管模式，指令取消", false);
    return pending !== undefined || entry !== undefined;
  }

  isAttached(id: string): boolean {
    const entry = this.drivers.get(id);
    return Boolean(entry?.ready && !entry.stopped && !entry.closed && !entry.rpc.closed);
  }
  isAttaching(id: string): boolean { return !this.isAttached(id) && this.attaching.has(id); }
  isReleasing(id: string): boolean {
    const entry = this.drivers.get(id);
    return Boolean(entry?.stopped && !entry.closed);
  }
  /** 并行执行互斥必须包含正在释放写者锁的阶段。 */
  isBusy(id: string): boolean { return this.attaching.has(id) || this.drivers.has(id); }
  runStatusFor(id: string): "running" | "idle" | "error" | null {
    const entry = this.drivers.get(id);
    return this.isAttached(id) && entry ? entry.turn ? "running" : entry.failed ? "error" : "idle" : null;
  }
  statusFor(id: string): TerminalAttachInfo {
    return { online: this.isAttached(id) || this.capabilityVerified, attached: this.isAttached(id), driver: "hub", mirror: false, source: "codex" };
  }
  snapshotFor(id: string): MessageDto[] {
    const entry = this.drivers.get(id);
    const turn = entry?.snapshotTurn;
    if (!entry || !turn) return [];
    const messages: MessageDto[] = turn.users.map((user) => ({ ...user, toolCalls: [], ...(user.images ? { images: user.images.map((image) => ({ ...image })) } : {}), ...(turn.id ? { turnId: turn.id } : {}), streaming: false }));
    messages.push(...[...turn.items.values()].map((item) => ({
      id: item.id, role: "assistant" as const, timestamp: item.timestamp, text: item.text,
      toolCalls: item.tool ? [{ ...item.tool }] : [], ...(turn.id ? { turnId: turn.id } : {}), streaming: entry.turn === turn && !turn.aborted && !item.ended,
    })));
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }
  commandStatusFor(id: string, commandId: string, now = Date.now()): CodexCommandStatus | null {
    const key = `${id}\0${commandId}`;
    const status = this.commandStates.get(key);
    if (!status) return null;
    if (now - status.at >= CLIENT_TTL_MS) { this.commandStates.delete(key); return null; }
    return { state: status.state, error: status.error };
  }

  send(id: string, input: CodexDriverSendInput): CodexDriverCommand {
    this.ensureAlive();
    const entry = this.drivers.get(id);
    if (!entry || !this.isAttached(id)) throw new HubError(ErrorCodes.ATTACH_REQUIRED, "该 Codex 会话尚未完成接管", 409);
    const mode = parseDriverMode(input.mode);
    const turnInput = buildTurnInput(input.text, input.images, entry.cwd);
    const clientMessageId = typeof input.clientMessageId === "string" && input.clientMessageId ? input.clientMessageId.slice(0, 128) : undefined;
    const clientKey = clientMessageId ? `${id}\0${clientMessageId}` : null;
    if (clientKey) {
      const seen = this.clientSeen.get(clientKey);
      if (seen && Date.now() - seen.at < CLIENT_TTL_MS) {
        // 重连或 HTTP 重试不能只收到 202 却永久等不到回执；已决指令重放原结果。
        // 失败也不自动再次执行：丢失 RPC 应答时模型可能已经收到了输入。
        if (seen.ack) this.emit(id, { type: "command_ack", commandId: seen.command.id, ...seen.ack });
        return seen.command;
      }
    }
    if (mode === "followUp" && entry.turn && entry.queue.length >= MAX_QUEUE) throw new HubError(ErrorCodes.ATTACH_QUEUE_FULL, "Codex 排队指令已满，请等待当前任务结束", 409);
    const images: MessageImage[] = (input.images ?? []).filter(isRecord).flatMap((image) =>
      typeof image.mimeType === "string" && image.mimeType.startsWith("image/") && typeof image.data === "string"
        ? [{ url: `data:${image.mimeType};base64,${image.data}`, alt: typeof image.path === "string" ? image.path : null }] : []);
    const command: Command = { id: `cmd-${randomUUID()}`, mode, text: input.text as string, input: turnInput, clientMessageId, timestamp: Date.now(), images, delivery: "local" };
    const result = { id: command.id, mode };
    if (clientKey) {
      this.clientSeen.set(clientKey, { command: result, at: Date.now() });
      trimMap(this.clientSeen, 2_000);
    }
    entry.commands.set(command.id, command);
    this.commandStates.set(`${id}\0${command.id}`, { state: "pending", error: null, at: Date.now() });
    trimMap(this.commandStates, 2_000);
    this.clearIdle(entry);
    if (entry.turn) {
      if (mode === "prompt") this.ack(entry, command, false, "会话正忙：prompt 仅空闲时可发，请用插话或排队");
      else if (mode === "followUp") entry.queue.push(command);
      else if (entry.turn.aborted) this.ack(entry, command, false, "当前轮正在中止，请等待收尾");
      else void this.steer(entry, entry.turn, command);
    } else this.startTurn(entry, command);
    return result;
  }

  private startTurn(entry: DriverEntry, command: Command): void {
    let resolveAccepted!: (id: string) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<string>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
    void accepted.catch(() => undefined);
    const turn: TurnState = {
      id: null, aborted: false, errorEmitted: false, accepted, resolveAccepted, rejectAccepted,
      buffered: [], items: new Map(), approvalPreviews: new Map(), users: [], interruptSent: false, interruptTimer: null,
    };
    entry.turn = turn; // 立即占用当前轮，避免两个 HTTP 请求同时启动两轮。
    entry.snapshotTurn = turn;
    entry.failed = false;
    this.clearIdle(entry);
    void (async () => {
      try {
        command.delivery = "sent";
        const response = await entry.rpc.request("turn/start", {
          threadId: entry.id, input: command.input,
          ...(command.clientMessageId ? { clientUserMessageId: command.clientMessageId } : {}),
        });
        if (entry.stopped || entry.turn !== turn) return;
        const value = isRecord(response) && isRecord(response.turn) ? response.turn : null;
        if (!value || typeof value.id !== "string" || !["inProgress", "completed", "interrupted", "failed"].includes(String(value.status))) {
          throw new CodexRpcError("PROTOCOL_ERROR", "Codex turn/start returned an incompatible turn");
        }
        turn.id = value.id;
        turn.resolveAccepted(value.id);
        if (!turn.aborted) {
          this.emit(entry.id, { type: "status", status: "running" });
          if (this.ack(entry, command, true, null)) this.emitUser(entry, turn, command);
        }
        const buffered = turn.buffered.splice(0);
        for (const event of buffered) {
          if (event.kind === "notification") this.handleNotification(entry, event.value);
          else this.handleServerRequest(entry, event.value);
        }
        if (entry.turn !== turn) return;
        if (turn.aborted) this.interrupt(entry, turn);
        if (value.status !== "inProgress") this.completeTurn(entry, turn, String(value.status), value.error);
      } catch (error) {
        turn.rejectAccepted(asError(error));
        if (entry.stopped || entry.turn !== turn) return;
        this.ack(entry, command, false, commandFailure(error));
        if (isTransportFailure(error)) { this.failEntry(entry, asError(error)); return; }
        entry.turn = null;
        entry.failed = true;
        this.clearQueue(entry, "当前轮未被 Codex 接收，排队指令取消");
        this.rejectHostRequests(entry, "cancelled");
        this.emit(entry.id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: safePreview(asError(error).message) });
        this.emit(entry.id, { type: "status", status: "error" });
        this.emit(entry.id, { type: "agent_settled" });
        this.touchIdle(entry);
      }
    })();
  }

  private async steer(entry: DriverEntry, turn: TurnState, command: Command): Promise<void> {
    try {
      const turnId = await turn.accepted;
      if (entry.stopped || entry.turn !== turn || turn.aborted) {
        this.ack(entry, command, false, "当前轮已结束或中止，插话未发送");
        return;
      }
      command.delivery = "sent";
      const result = await entry.rpc.request("turn/steer", { threadId: entry.id, expectedTurnId: turnId, input: command.input });
      if (!isRecord(result) || result.turnId !== turnId) throw new CodexRpcError("PROTOCOL_ERROR", "Codex turn/steer returned a different turn");
      if (entry.stopped || turn.aborted) { this.ack(entry, command, false, "插话完成前会话已中止或断开"); return; }
      if (this.ack(entry, command, true, null)) this.emitUser(entry, turn, command);
    } catch (error) {
      this.ack(entry, command, false, commandFailure(error));
      if (!entry.stopped && isTransportFailure(error)) this.failEntry(entry, asError(error));
    }
  }

  abortTurn(id: string): void {
    const entry = this.drivers.get(id);
    const pending = this.attaching.get(id);
    if (pending && !this.isAttached(id)) {
      pending.controller.abort(unavailable("Codex 接管准备已中止"));
      if (entry) this.stopEntry(entry, "Codex 接管准备已中止", false);
      return;
    }
    if (!entry || !this.isAttached(id)) return;
    this.clearQueue(entry, "已中止当前运行，排队指令取消");
    this.rejectHostRequests(entry, "cancelled");
    const turn = entry.turn;
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    // 中止时给未完成注入明确的单次失败回执；迟到 RPC 应答不得重新确认成功。
    for (const command of [...entry.commands.values()]) this.ack(entry, command, false, "当前轮已中止");
    if (turn.id) this.interrupt(entry, turn);
  }

  private interrupt(entry: DriverEntry, turn: TurnState): void {
    if (!turn.id || turn.interruptSent || entry.stopped || entry.turn !== turn) return;
    turn.interruptSent = true;
    turn.interruptTimer = setTimeout(() => {
      if (entry.turn === turn && !entry.stopped) this.failEntry(entry, new CodexRpcError("INTERRUPT_TIMEOUT", "Codex 中止后未在时限内结束当前轮"));
    }, this.options.interruptTimeoutMs ?? 30_000);
    void entry.rpc.request("turn/interrupt", { threadId: entry.id, turnId: turn.id }).catch((error: unknown) => {
      if (entry.turn === turn && !entry.stopped) this.failEntry(entry, asError(error));
    });
  }

  private handleNotification(entry: DriverEntry, event: CodexNotification): void {
    if (entry.stopped || !isRecord(event.params)) return;
    const params = event.params;
    if (params.threadId !== entry.id) return;
    if (event.method === "serverRequest/resolved") {
      if (!isRpcId(params.requestId)) return;
      const rawKey = nativeKey(params.requestId);
      if (entry.nativeRequestTurns.get(rawKey) === null && typeof params.turnId !== "string") return;
      const turnId = typeof params.turnId === "string" ? params.turnId : entry.turn?.id;
      if (!turnId || entry.retiredTurns.has(turnId)) return;
      const phoneId = entry.nativeRequests.get(nativeTurnKey(params.requestId, turnId));
      const request = phoneId ? entry.hostRequests.get(phoneId) : undefined;
      // 此事件只说明请求已清理，不能据此推断已经批准。
      if (request) this.finishHostRequest(entry, request, "deny", "cancelled", false);
      return;
    }
    if (event.method === "thread/status/changed") {
      if (entry.ready && isRecord(params.status) && (params.status.type === "notLoaded" || params.status.type === "systemError")) {
        this.failEntry(entry, new Error("Codex 线程已卸载或发生系统错误"));
      }
      return;
    }
    const turn = entry.turn;
    if (!entry.ready || !turn) return;
    const turnId = event.method === "turn/started" || event.method === "turn/completed"
      ? isRecord(params.turn) ? params.turn.id : undefined : params.turnId;
    if (typeof turnId !== "string" || entry.retiredTurns.has(turnId)) return;
    if (turn.id === null) { this.buffer(entry, turn, { kind: "notification", value: event }); return; }
    if (turnId !== turn.id) return;
    if (event.method === "turn/completed") {
      if (isRecord(params.turn)) this.completeTurn(entry, turn, String(params.turn.status), params.turn.error);
      return;
    }
    if (turn.aborted) return;
    if (event.method === "error") {
      const error = isRecord(params.error) ? params.error.message : "Codex 运行失败";
      if (!turn.errorEmitted) {
        turn.errorEmitted = true;
        this.emit(entry.id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: safePreview(typeof error === "string" ? error : "Codex 运行失败") });
      }
      // 可重试或不可重试的 error 都等待 turn/completed 再整轮收尾。
      return;
    }
    if (event.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const message = this.ensureItem(entry, turn, params.itemId, null);
      if (message.ended) return;
      message.text += params.delta;
      this.emit(entry.id, { type: "text_delta", messageId: message.id, delta: params.delta });
      return;
    }
    if ((event.method === "item/started" || event.method === "item/completed") && isRecord(params.item)) {
      this.handleItem(entry, turn, params.item, event.method === "item/completed");
    }
  }

  private buffer(entry: DriverEntry, turn: TurnState, event: BufferedEvent): void {
    if (turn.buffered.length >= MAX_BUFFERED_EVENTS) {
      this.failEntry(entry, new CodexRpcError("PROTOCOL_ERROR", "Codex 在确认当前轮之前发送了过多事件"));
      return;
    }
    turn.buffered.push(event);
  }

  private ensureItem(entry: DriverEntry, turn: TurnState, itemId: string, tool: ToolCallDto | null): LiveItem {
    const existing = turn.items.get(itemId);
    if (existing) return existing;
    const message: LiveItem = { id: codexMessageId(entry.id, itemId), timestamp: Date.now(), text: "", tool, ended: false };
    turn.items.set(itemId, message);
    this.emit(entry.id, { type: "message_start", message: { id: message.id, role: "assistant", timestamp: message.timestamp } });
    if (tool) this.emit(entry.id, { type: "tool_start", messageId: message.id, toolCall: { name: tool.name, summary: tool.summary } });
    return message;
  }

  private handleItem(entry: DriverEntry, turn: TurnState, item: Record<string, unknown>, completed: boolean): void {
    if (typeof item.id !== "string" || typeof item.type !== "string") return;
    const preview = approvalItemPreview(item);
    if (preview) turn.approvalPreviews.set(item.id, preview);
    if (item.type === "agentMessage") {
      // 尚无文本的 commentary 条目不创建空 assistant 气泡。
      const text = typeof item.text === "string" ? item.text : "";
      if (!completed || (!text && !turn.items.has(item.id))) return;
      const message = this.ensureItem(entry, turn, item.id, null);
      if (message.ended) return;
      if (typeof item.text === "string") message.text = item.text;
      this.endItem(entry, message);
      return;
    }
    const tool = toolInfo(item);
    if (!tool) return;
    const message = this.ensureItem(entry, turn, item.id, tool);
    if (message.ended || !message.tool || !completed) return;
    const status = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0) || item.isError === true ? "error" : "done";
    message.tool.status = status;
    message.tool.resultPreview = toolResult(item);
    this.emit(entry.id, { type: "tool_end", messageId: message.id, toolCall: { ...message.tool } });
    this.endItem(entry, message);
  }

  private endItem(entry: DriverEntry, message: LiveItem): void {
    if (message.ended) return;
    message.ended = true;
    this.emit(entry.id, { type: "message_end", message: {
      id: message.id, role: "assistant", timestamp: message.timestamp, text: message.text,
      toolCalls: message.tool ? [{ ...message.tool }] : [], ...(entry.turn?.id ? { turnId: entry.turn.id } : {}),
    } });
  }

  private completeTurn(entry: DriverEntry, turn: TurnState, status: string, error: unknown): void {
    if (entry.turn !== turn || entry.stopped) return;
    if (!["completed", "interrupted", "failed"].includes(status)) {
      this.failEntry(entry, new CodexRpcError("PROTOCOL_ERROR", "Codex turn/completed returned an invalid terminal status"));
      return;
    }
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    turn.interruptTimer = null;
    this.rejectHostRequests(entry, "cancelled");
    for (const message of turn.items.values()) {
      if (message.ended) continue;
      if (message.tool?.status === "running") {
        message.tool.status = status === "completed" ? "done" : "error";
        this.emit(entry.id, { type: "tool_end", messageId: message.id, toolCall: { ...message.tool } });
      }
      this.endItem(entry, message);
    }
    entry.turn = null;
    if (turn.id) { entry.retiredTurns.add(turn.id); trimSet(entry.retiredTurns, 100); }
    entry.failed = status === "failed";
    if (entry.failed && !turn.errorEmitted) this.emit(entry.id, {
      type: "error", code: ErrorCodes.PROMPT_FAILED,
      message: safePreview(isRecord(error) && typeof error.message === "string" ? error.message : "Codex 运行失败"),
    });
    this.emit(entry.id, { type: "status", status: entry.failed ? "error" : "idle" });
    this.emit(entry.id, { type: "agent_settled" });
    const next = entry.queue.shift();
    if (next) this.startTurn(entry, next);
    else this.touchIdle(entry);
  }

  private handleServerRequest(entry: DriverEntry, request: CodexServerRequest): void {
    const type = Object.hasOwn(APPROVAL_METHODS, request.method) ? APPROVAL_METHODS[request.method] : undefined;
    if (!type) {
      // token 刷新绝不转给手机；不替未作答的用户选择任何选项。
      const message = request.method === "item/tool/requestUserInput"
        ? "This client does not support interactive questions; the user has not answered or granted consent"
        : "This client does not support this server request";
      if (request.method === "mcpServer/elicitation/request") void entry.rpc.respond(request.id, { action: "decline", content: null }).catch(() => undefined);
      else void entry.rpc.respondError(request.id, -32601, message).catch(() => undefined);
      return;
    }
    const params = isRecord(request.params) ? request.params : {};
    const turn = entry.turn;
    if (!entry.stopped && entry.ready && turn && turn.id === null && params.threadId === entry.id && typeof params.turnId === "string") {
      this.buffer(entry, turn, { kind: "request", value: request });
      return;
    }
    const valid = !entry.stopped && entry.ready && turn && !turn.aborted && params.threadId === entry.id && params.turnId === turn.id && typeof params.itemId === "string";
    if (!valid) {
      void entry.rpc.respond(request.id, buildApprovalResult(type, "deny", {}, true)).catch(() => undefined);
      return;
    }
    const native = nativeTurnKey(request.id, turn.id!);
    const previous = entry.nativeRequests.get(native);
    if (previous) {
      if (!entry.hostRequests.has(previous)) void entry.rpc.respond(request.id, buildApprovalResult(type, "deny", {}, true)).catch(() => undefined);
      return;
    }
    const now = Date.now();
    const ttl = this.options.hostRequestTtlMs ?? 5 * 60_000;
    const id = `codex-host-${randomUUID()}`;
    const preview = hostRequestPreview(type, params, turn.approvalPreviews.get(params.itemId as string));
    const dto: HostRequestDto & { requestType: CodexApprovalType; turnId: string; itemId: string } = {
      id, sessionId: entry.id, kind: "permission", requestType: type,
      title: preview.title, detail: preview.detail, toolName: preview.toolName,
      turnId: turn.id!, itemId: params.itemId as string, allowAlways: false,
      createdAt: now, expiresAt: now + ttl,
    };
    const host: HostRequestEntry = {
      id, nativeId: request.id, type, turnId: turn.id!, permissions: snapshotRequestedPermissions(params.permissions), dto,
      timer: setTimeout(() => this.finishHostRequest(entry, host, "deny", "timeout"), ttl),
    };
    host.timer.unref?.();
    entry.hostRequests.set(id, host);
    entry.nativeRequests.set(native, id);
    const rawKey = nativeKey(request.id);
    const previousTurn = entry.nativeRequestTurns.get(rawKey);
    entry.nativeRequestTurns.set(rawKey, previousTurn === undefined || previousTurn === turn.id ? turn.id! : null);
    trimMap(entry.nativeRequests, 1_000);
    trimMap(entry.nativeRequestTurns, 1_000);
    this.emit(entry.id, { type: "host_request", request: { ...dto } });
  }

  listHostRequests(id: string): HostRequestDto[] {
    return [...(this.drivers.get(id)?.hostRequests.values() ?? [])].map((request) => ({ ...request.dto }));
  }

  respondHostRequest(id: string, requestId: string, decision: CodexHostRequestDecision): boolean {
    const entry = this.drivers.get(id);
    const request = entry?.hostRequests.get(requestId);
    if (!entry || !request) return false;
    if (decision.outcome !== "allow" && decision.outcome !== "deny") throw new HubError(ErrorCodes.INVALID_REQUEST, "outcome 必须为 allow|deny");
    const current = entry.ready && !entry.stopped && entry.turn?.id === request.turnId && !entry.turn.aborted;
    const expired = (request.dto.expiresAt ?? 0) <= Date.now();
    if (!current || expired) {
      this.finishHostRequest(entry, request, "deny", expired ? "timeout" : "cancelled");
      return false;
    }
    this.finishHostRequest(entry, request, decision.outcome, decision.outcome);
    return true;
  }

  private finishHostRequest(entry: DriverEntry, request: HostRequestEntry, decision: "allow" | "deny", outcome: HostRequestOutcome, send = true): void {
    if (entry.hostRequests.get(request.id) !== request) return;
    clearTimeout(request.timer);
    entry.hostRequests.delete(request.id);
    this.resolvedHostRequests.set(request.id, Date.now() + RESOLVED_TTL_MS);
    trimMap(this.resolvedHostRequests, 200);
    if (send) void entry.rpc.respond(request.nativeId, buildApprovalResult(request.type, decision, request.permissions, outcome === "cancelled")).catch((error: unknown) => {
      if (!entry.stopped) this.failEntry(entry, asError(error));
    });
    this.emit(entry.id, { type: "host_request_resolved", requestId: request.id, outcome });
  }

  isResolvedHostRequest(requestId: string, now = Date.now()): boolean {
    const expires = this.resolvedHostRequests.get(requestId);
    if (expires === undefined) return false;
    if (expires <= now) { this.resolvedHostRequests.delete(requestId); return false; }
    return true;
  }

  private rejectHostRequests(entry: DriverEntry, outcome: "timeout" | "cancelled"): void {
    for (const request of [...entry.hostRequests.values()]) this.finishHostRequest(entry, request, "deny", outcome);
    const buffered = entry.turn?.buffered ?? [];
    for (const item of buffered) {
      if (item.kind === "request") {
        const type = Object.hasOwn(APPROVAL_METHODS, item.value.method) ? APPROVAL_METHODS[item.value.method] : undefined;
        if (type) void entry.rpc.respond(item.value.id, buildApprovalResult(type, "deny", {}, true)).catch(() => undefined);
      }
    }
    if (entry.turn) entry.turn.buffered = buffered.filter((item) => item.kind !== "request");
  }

  startSweep(): void {
    if (this.disposed || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref?.();
  }
  sweep(now = Date.now()): void {
    for (const [key, seen] of this.clientSeen) if (now - seen.at >= CLIENT_TTL_MS) this.clientSeen.delete(key);
    for (const [key, status] of this.commandStates) if (now - status.at >= CLIENT_TTL_MS) this.commandStates.delete(key);
    for (const [id, expires] of this.resolvedHostRequests) if (expires <= now) this.resolvedHostRequests.delete(id);
  }
  disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const attempt of this.attaching.values()) attempt.controller.abort(unavailable("server 正在关闭，Codex 接管已取消"));
    for (const entry of this.drivers.values()) this.stopEntry(entry, "server 正在关闭，指令取消", false);
    this.clientSeen.clear();
    this.commandStates.clear();
    this.resolvedHostRequests.clear();
  }

  private failEntry(entry: DriverEntry, error: Error): void {
    if (entry.stopped) return;
    this.stopEntry(entry, safePreview(error.message), true);
  }

  private stopEntry(entry: DriverEntry, reason: string, failed: boolean): void {
    if (entry.stopped) return;
    const wasReady = entry.ready;
    entry.stopped = true;
    entry.ready = false;
    this.clearIdle(entry);
    this.clearQueue(entry, reason);
    this.rejectHostRequests(entry, "cancelled");
    const turn = entry.turn;
    if (turn) {
      turn.aborted = true;
      turn.rejectAccepted(new Error(reason));
      if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
      for (const message of turn.items.values()) {
        if (message.tool && !message.ended) message.tool.status = "error";
        this.endItem(entry, message);
      }
      entry.turn = null;
      this.emit(entry.id, { type: "status", status: failed ? "error" : "idle" });
      this.emit(entry.id, { type: "agent_settled" });
    }
    for (const command of [...entry.commands.values()]) this.ack(entry, command, false, command.delivery === "sent"
      ? `${reason}；未确认此消息是否已被接收，请先核对会话内容。` : reason);
    if (failed && wasReady) this.emit(entry.id, { type: "error", code: ErrorCodes.DRIVER_FAILED, message: `Codex 接管已断开：${safePreview(reason)}` });
    entry.rpc.dispose(new Error(reason));
    entry.snapshotTurn = null;
    this.emit(entry.id, { type: "attach_state", attached: false, terminalOnline: false });
    // unsubscribe 不会释放写者锁；必须终止进程，真实退出前仍占容量。
    // 若 TERM 未能退出，再用 KILL 收尾。
    if (!entry.closed) {
      try { entry.child.kill("SIGTERM"); } catch { /* 仍保留后续 SIGKILL 收尾 */ }
      if (!entry.closed) {
        entry.killTimer = setTimeout(() => { if (!entry.closed) { try { entry.child.kill("SIGKILL"); } catch { /* 进程已不存在 */ } } }, KILL_GRACE_MS);
        entry.killTimer.unref?.();
      }
    } else if (this.drivers.get(entry.id) === entry) this.drivers.delete(entry.id);
  }

  private clearQueue(entry: DriverEntry, reason: string): void {
    for (const command of entry.queue.splice(0)) this.ack(entry, command, false, reason);
  }
  private ack(entry: DriverEntry, command: Command, ok: boolean, error: string | null): boolean {
    if (!entry.commands.delete(command.id)) return false;
    this.commandStates.set(`${entry.id}\0${command.id}`, { state: ok ? "accepted" : "failed", error, at: Date.now() });
    trimMap(this.commandStates, 2_000);
    if (command.clientMessageId) {
      const seen = this.clientSeen.get(`${entry.id}\0${command.clientMessageId}`);
      if (seen?.command.id === command.id) {
        // 本地尚未发送的失败可安全重试；已交给 RPC 的结果则保留，避免重复执行。
        if (!ok && command.delivery === "local") this.clientSeen.delete(`${entry.id}\0${command.clientMessageId}`);
        else seen.ack = { ok, error };
      }
    }
    this.emit(entry.id, { type: "command_ack", commandId: command.id, ok, error });
    return true;
  }
  private emitUser(entry: DriverEntry, turn: TurnState, command: Command): void {
    const message: MessageDto = {
      id: `live-user-${command.id}`, role: "user", timestamp: command.timestamp, text: command.text, toolCalls: [],
      ...(turn.id ? { turnId: turn.id } : {}),
      ...(command.images.length ? { images: command.images.map((image) => ({ ...image })) } : {}),
    };
    turn.users.push(message);
    this.emit(entry.id, { type: "message_end", message: { ...message, ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}) } });
  }
  private emit(id: string, event: ServerEvent): void { try { this.options.emit(id, event); } catch { /* 界面回调异常不得破坏写者生命周期 */ } }
  private clearIdle(entry: DriverEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  private touchIdle(entry: DriverEntry): void {
    this.clearIdle(entry);
    const delay = this.options.idleDetachMs ?? 30 * 60_000;
    if (delay <= 0 || !entry.ready || entry.stopped || entry.turn || entry.hostRequests.size) return;
    entry.idleTimer = setTimeout(() => { if (!entry.turn && !entry.hostRequests.size) this.detach(entry.id); }, delay);
    entry.idleTimer.unref?.();
  }
  private ensureAlive(): void { if (this.disposed) throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503); }
}

/** 只探测 CLI 版本，不调用模型，也不读取凭据/配置文件。 */
export function probeCodexCapabilities(context: CodexPreparationContext): Promise<CodexDriverCapabilities> {
  throwIfAborted(context.signal);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = context.spawnFn(context.codexBin, ["--version"], { cwd: context.cwd || undefined, env: context.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { reject(unavailable("无法运行所配置的 Codex 可执行文件")); return; }
    let output = "";
    let finished = false;
    const timer = setTimeout(() => finish(unavailable("Codex 版本探测超时")), 5_000);
    const onAbort = () => finish(asError(context.signal.reason));
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      if (error) { try { child.kill("SIGKILL"); } catch { /* 进程未能创建 */ } reject(error); return; }
      const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?/);
      if (!match) { reject(unavailable("无法识别 Codex 版本，请配置支持 app-server 的 Codex 版本")); return; }
      const supported = Number(match[1]) > 0 || Number(match[2]) >= 162;
      resolve({ version: match[0], appServer: supported, writerLock: supported });
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { output = (output + String(chunk)).slice(0, 4_096); });
    child.stderr?.on("data", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.stdout?.on("error", () => finish(unavailable("Codex 版本探测输出失败")));
    child.on("error", () => finish(unavailable("无法运行所配置的 Codex 可执行文件")));
    child.on("close", (code) => finish(code === 0 ? undefined : unavailable("Codex 版本探测失败")));
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
  });
}

function toolInfo(item: Record<string, unknown>): ToolCallDto | null {
  const names: Record<string, string> = {
    commandExecution: "commandExecution", fileChange: "fileChange", mcpToolCall: "mcpToolCall", dynamicToolCall: "dynamicToolCall",
    webSearch: "webSearch", imageGeneration: "imageGeneration", collabAgentToolCall: "collabAgentToolCall",
  };
  const type = String(item.type);
  if (!Object.hasOwn(names, type)) return null;
  const name = (type === "mcpToolCall" || type === "dynamicToolCall") && typeof item.tool === "string" ? item.tool : names[type];
  let summary = name;
  if (typeof item.command === "string") summary = item.command;
  else if (Array.isArray(item.changes)) summary = item.changes.filter(isRecord).map((change) => typeof change.path === "string" ? change.path : "").filter(Boolean).join(", ") || name;
  else if (typeof item.server === "string") summary = `${item.server}: ${name}`;
  return { name, summary: safePreview(summary, 300), status: "running", resultPreview: null };
}
function toolResult(item: Record<string, unknown>): string | null {
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) return safePreview(item.aggregatedOutput, 1_000);
  if (isRecord(item.error) && typeof item.error.message === "string") return safePreview(item.error.message, 1_000);
  if (typeof item.output === "string" && item.output) return safePreview(item.output, 1_000);
  const result = isRecord(item.result) ? item.result : item;
  const blocks = Array.isArray(result.content) ? result.content : Array.isArray(result.contentItems) ? result.contentItems : [];
  const text = blocks.filter(isRecord).map((block) => typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
  return text ? safePreview(text, 1_000) : null;
}
function unavailable(message: string): HubError { return new HubError(ErrorCodes.ATTACH_UNAVAILABLE, message, 409); }
function attachError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  const message = safePreview(asError(error).message);
  if (/active writer|already.*writer|writer.*(?:held|active|busy)|thread.*already.*(?:active|running)/i.test(message)) return new HubError(ErrorCodes.SESSION_BUSY, `Codex 会话正由其他客户端占用：${message}`, 409);
  return unavailable(`Codex 接管不可用：${message}`);
}
function isTransportFailure(error: unknown): boolean { return error instanceof CodexRpcError && typeof error.code === "string"; }
function commandFailure(error: unknown): string {
  const message = safePreview(asError(error).message);
  return error instanceof CodexRpcError && error.code === "RPC_TIMEOUT"
    ? `Codex 未确认是否收到此消息，请先核对会话内容；相同消息编号不会自动重发。${message}` : message;
}
function nativeKey(id: CodexRpcId): string { return `${typeof id}:${id}`; }
function nativeTurnKey(id: CodexRpcId, turnId: string): string { return `${turnId}\0${nativeKey(id)}`; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("Codex 请求失败"); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw asError(signal.reason); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(asError(signal.reason)); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(asError(signal.reason)); };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
function trimMap<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) { const key = map.keys().next(); if (key.done) break; map.delete(key.value); }
}
function trimSet<T>(set: Set<T>, limit: number): void {
  while (set.size > limit) { const key = set.values().next(); if (key.done) break; set.delete(key.value); }
}
