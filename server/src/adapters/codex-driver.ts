/**
 * 每个接管会话独占一个持有写者锁的 app-server 进程。
 * 不回落 exec、不放宽策略、不读凭据或 shell 初始化文件，也不自动批准请求。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { ErrorCodes, HubError } from "../errors.js";
import type { EffectivePolicyDto, HostRequestDto, HostRequestOutcome, HostUserQuestion, MessageDto, MessageImage, ServerEvent, TerminalAttachInfo, ToolCallDto } from "../types.js";
import {
  APPROVAL_METHODS, approvalItemPreview, buildApprovalResult, buildDriverArgs, buildElicitationAccept, buildResumeParams, buildTurnInput,
  buildUserInputResult, codexMessageId, declinedRpcReply, hostRequestPreview, parseDriverMode, parseEffectivePolicy,
  parseElicitationQuestions, parseUserInputQuestions, questionCardPreview, safePreview, serverRequestKind, snapshotRequestedPermissions,
  unansweredRpcReply, validateQuestionAnswers,
  type CodexApprovalItemPreview, type CodexApprovalPolicy, type CodexApprovalType, type CodexDriverMode, type CodexRpcReply, type CodexSandbox, type CodexUserInput,
  type ElicitationValueType, type HostRequestKind,
} from "./codex-host-protocol.js";
import { planPolicyOverrides, assertPolicyNotWeaker, type PolicyOverrides } from "./codex-policy.js";
import { CodexRpc, CodexRpcError, isRecord, isRpcId, type CodexNotification, type CodexRpcId, type CodexServerRequest } from "./codex-rpc.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;
export interface CodexDriverCommand { id: string; mode: CodexDriverMode }
/**
 * 手机应答（union）：审批用 outcome；问答（kind===question）用 answers（键 = questions[].id）。
 * outcome:"deny" 对问答的语义 = 用户拒绝回答（仍绝不代答）；二者互斥，不得混用。
 */
export type CodexHostRequestDecision =
  | { outcome: "allow" | "deny"; message?: string }
  | { answers: Record<string, string[]> };
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
  /** 轮次不活跃 watchdog（毫秒）：本轮长时间没有任何 codex 事件、也没有终态通知时兜底收尾；<=0 关闭。 */
  turnWatchdogMs?: number;
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
  /** 本轮最后一次可重试错误（willRetry:true）文本；只在终态未给出真实原因时兜底展示。 */
  lastRetryableError: string | null;
  accepted: Promise<string>;
  resolveAccepted: (id: string) => void;
  rejectAccepted: (error: Error) => void;
  buffered: BufferedEvent[];
  items: Map<string, LiveItem>;
  approvalPreviews: Map<string, CodexApprovalItemPreview>;
  users: MessageDto[];
  interruptSent: boolean;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /** 本轮最后一次活动时间（codex 通知与审批动作都会刷新），watchdog 据此判定轮次是否停滞。 */
  lastActivity: number;
  watchdog: ReturnType<typeof setTimeout> | null;
}
interface HostRequestEntry {
  id: string;
  nativeId: CodexRpcId;
  /** rpc 应答通道：审批三类 / requestUserInput 问答 / MCP elicitation */
  kind: HostRequestKind;
  /** 审批类型（kind==="approval"）；问答/elicitation 为 null */
  type: CodexApprovalType | null;
  turnId: string;
  permissions: Record<string, unknown>;
  /** elicitation 属性类型表：accept 时按它归一 content 值（string/number/boolean） */
  elicitationTypes: Record<string, ElicitationValueType>;
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
  /** thread/resume 协议回显归一化后的生效策略（P1-2）；未回显时缺省，前端按「未知」容错。 */
  effectivePolicy?: EffectivePolicyDto;
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
/** 轮次不活跃兜底阈值：丢失 turn/completed 时的最长等待，避免会话永久停在 running。 */
const TURN_INACTIVITY_MS = 10 * 60_000;
/** JSON-RPC invalid request：codex 用它表达写者互斥（线程已被其它客户端占用）。 */
const RPC_INVALID_REQUEST = -32600;
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
  /**
   * 已在本进程内验证过「能完成 app-server 握手 + 写者互斥 resume」的会话 id。
   * 必须按会话记录：早先是进程级单次标志，任一会话接管成功后所有 codex 会话的
   * statusFor().online 都会变 true，未接管的会话被误报为在线。
   */
  private readonly capabilityVerified = new Set<string>();

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
      let baseline: unknown;
      let overrides: PolicyOverrides = {};
      for (let pass = 0; pass < 2; pass += 1) {
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
        // 子进程可能只发 exit/error 而不发 close（spawn 失败、kill 抛错等）。只依赖 close 时
        // 条目会永驻 drivers：该会话永久 isReleasing/isBusy，并长期占用一个 maxConcurrent 名额。
        // 三个事件共用同一幂等收尾：标记 closed、清理 SIGKILL 定时器、摘除条目。
        const settle = (kind: "close" | "exit" | "error") => {
          // error 只在进程确定不可用时兜底（RPC 已断开、已主动收尾或已退出），
          // 否则 kill 失败之类的 error 会把一个仍在运行的进程误判为已释放写者锁。
          if (kind === "error" && child.pid !== undefined && child.exitCode === null && child.signalCode === null) return;
          current.closed = true;
          if (current.killTimer) clearTimeout(current.killTimer);
          current.killTimer = null;
          if (this.drivers.get(id) === current) this.drivers.delete(id);
        };
        child.on("close", () => settle("close"));
        child.on("exit", () => settle("exit"));
        child.on("error", () => settle("error"));
        this.drivers.set(id, current);
        await abortable(current.rpc.request("initialize", {
          clientInfo: { name: "agent_hub", title: "Agent Hub", version: "0.3.0" },
          capabilities: { experimentalApi: true },
        }), controller.signal);
        check();
        await abortable(current.rpc.notify("initialized"), controller.signal);
        check();
        const result = await abortable(current.rpc.request("thread/resume", buildResumeParams(id, {
          cwd: opts.cwd, ...overrides,
        })), controller.signal);
        check();
        if (current.stopped) throw unavailable("Codex 接管连接已关闭");
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
        if (!thread || thread.id !== id || !isRecord(thread.status)) throw unavailable("Codex thread/resume 返回了不兼容的线程状态");
        if (thread.status.type === "active") throw new HubError(ErrorCodes.SESSION_BUSY, "Codex 会话仍在运行，等待电脑端结束后再接管", 409);
        if (thread.status.type !== "idle") throw unavailable(`Codex 会话当前无法接管（${safePreview(String(thread.status.type), 80)}）`);
        if (pass === 0) {
          baseline = result;
          overrides = planPolicyOverrides(baseline, { approvalPolicy: this.options.approvalPolicy, sandbox: this.options.sandbox });
          if (Object.keys(overrides).length > 0) {
            // 0.162 在同一进程重复 resume 会忽略覆盖参数，必须先确认旧 writer 释放再重建。
            this.stopEntry(current, "正在应用收紧后的权限", false, false);
            await abortable(waitForDriverRelease(current), controller.signal);
            check();
            await this.waitForExternalQuiet(opts.sessionFile, controller.signal);
            check();
            continue;
          }
        } else assertPolicyNotWeaker(baseline, result, overrides, opts.cwd);
        // P1-2：从 thread/resume 回显解析实际生效策略（只取协议回显，不读 ~/.codex/config.toml）。
        // 解析不出 = 不回传该字段，前端按「未知」容错，绝不把缺省当成安全档位。
        const policy = parseEffectivePolicy(result);
        if (policy) current.effectivePolicy = policy;
        current.ready = true;
        this.capabilityVerified.add(id);
        trimSet(this.capabilityVerified, 200);
        this.touchIdle(current);
        this.emit(id, { type: "attach_state", attached: true, terminalOnline: true, source: "codex", ...(policy ? { effectivePolicy: policy } : {}) });
        return { attached: true, driver: "hub", mirror: false };
      }
      throw unavailable("Codex 权限初始化未完成");
    } catch (error) {
      if (entry) this.stopEntry(entry, "Codex 接管启动失败", false);
      throw attachError(error);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async assertExternalQuiet(sessionFile: string, now: number): Promise<void> {
    if (await this.externalQuietDelay(sessionFile, now) > 0) throw unavailable("电脑端正在写入该会话，请稍候再接管");
  }

  /** resume/退出也会更新 rollout；旧 writer 释放后等到静默，而不是把自身写入直接当成冲突。
   * 每次等待后重新 stat；外部持续写入或文件不可读时绝不能启动第二个 writer。
   * 沿用启动总 deadline，退出接管也能立即取消等待。
   */
  private async waitForExternalQuiet(sessionFile: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const remaining = await abortable(this.externalQuietDelay(sessionFile, Date.now()), signal);
      if (remaining <= 0) return;
      await abortable(wait(Math.min(remaining, 1_000), undefined, { signal }), signal);
    }
  }

  private async externalQuietDelay(sessionFile: string, now: number): Promise<number> {
    if ((this.options.externalQuietMs ?? 3_000) <= 0) return 0;
    try {
      const info = await (this.options.statFn ?? stat)(sessionFile);
      return Math.max(0, info.mtimeMs + (this.options.externalQuietMs ?? 3_000) - now);
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
    const attached = this.isAttached(id);
    // online 只描述本会话：已接管，或本进程确实验证过它可以被接管（可重新接管）。
    const info: TerminalAttachInfo = { online: attached || this.capabilityVerified.has(id), attached, driver: "hub", mirror: false, source: "codex" };
    // P1-2：接管期间带出生效策略（bypass=true → 审批通道空转）；未接管/未回显时不带出，
    // 前端按「未知」容错（可选字段缺省不出现 = 向后兼容）。
    const policy = this.drivers.get(id)?.effectivePolicy;
    if (policy) info.effectivePolicy = policy;
    return info;
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
      id: null, aborted: false, errorEmitted: false, lastRetryableError: null, accepted, resolveAccepted, rejectAccepted,
      buffered: [], items: new Map(), approvalPreviews: new Map(), users: [], interruptSent: false, interruptTimer: null,
      lastActivity: Date.now(), watchdog: null,
    };
    entry.turn = turn; // 立即占用当前轮，避免两个 HTTP 请求同时启动两轮。
    entry.snapshotTurn = turn;
    entry.failed = false;
    this.clearIdle(entry);
    this.armTurnWatchdog(entry, turn);
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
        // 本轮已不再持有 turn，watchdog 不能再悬挂到超时（stopEntry 路径由其自身清理）。
        if (turn.watchdog) clearTimeout(turn.watchdog);
        turn.watchdog = null;
        this.clearQueue(entry, "当前轮未被 Codex 接收，排队指令取消");
        this.rejectHostRequests(entry, "cancelled");
        // 写者互斥（-32600）不是笼统失败：让手机端能看出是会话已被其它客户端占用。
        const conflict = isWriterConflict(error);
        this.emit(entry.id, {
          type: "error", code: conflict ? ErrorCodes.SESSION_BUSY : ErrorCodes.PROMPT_FAILED,
          message: conflict ? commandFailure(error) : safePreview(asError(error).message),
        });
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
    turn.interruptTimer.unref?.();
    void entry.rpc.request("turn/interrupt", { threadId: entry.id, turnId: turn.id }).catch((error: unknown) => {
      if (entry.turn === turn && !entry.stopped) this.failEntry(entry, asError(error));
    });
  }

  /**
   * 轮次终局兜底：丢失或未发 turn/completed 时，entry.turn 永不清空会让会话
   * 永久 running（不触发 idle-detach，后续 prompt 一律「会话正忙」）。
   * 超时后走与既有失败收尾相同的 failEntry（error + agent_settled + status error 并终止进程
   * 释放写者锁），不留下可能仍在执行的僵尸进程。
   * 注意不能看到 thread/status/changed === idle 就立即收尾：等审批时 thread 也可能报 idle，
   * 那样会误杀正在等手机点「允许」的轮次；改为有未决审批时不计入不活跃时长。
   */
  private armTurnWatchdog(entry: DriverEntry, turn: TurnState): void {
    const limit = this.options.turnWatchdogMs ?? TURN_INACTIVITY_MS;
    if (limit <= 0) return;
    const check = () => {
      turn.watchdog = null;
      // 幂等：本轮已正常收尾（completeTurn/stopEntry）或已换轮时不再重复处理。
      if (entry.stopped || entry.turn !== turn) return;
      const now = Date.now();
      if (entry.hostRequests.size) turn.lastActivity = now;
      const elapsed = now - turn.lastActivity;
      if (elapsed >= limit) {
        this.failEntry(entry, new CodexRpcError("TURN_INACTIVE", `Codex 超过 ${Math.round(limit / 1_000)} 秒未推进当前轮，也未发送终态通知`));
        return;
      }
      turn.watchdog = setTimeout(check, limit - elapsed);
      turn.watchdog.unref?.();
    };
    turn.watchdog = setTimeout(check, limit);
    turn.watchdog.unref?.();
  }

  /** 刷新轮次活动基线：watchdog 只统计「codex 与手机都无动作」的静默时长。 */
  private touchTurn(entry: DriverEntry): void {
    if (entry.turn) entry.turn.lastActivity = Date.now();
  }

  private handleNotification(entry: DriverEntry, event: CodexNotification): void {
    if (entry.stopped || !isRecord(event.params)) return;
    const params = event.params;
    if (params.threadId !== entry.id) return;
    // 任何本线程通知（item/delta/status/error 等）都算本轮有推进，刷新 watchdog 基线。
    this.touchTurn(entry);
    if (event.method === "serverRequest/resolved") {
      if (!isRpcId(params.requestId)) return;
      const rawKey = nativeKey(params.requestId);
      if (entry.nativeRequestTurns.get(rawKey) === null && typeof params.turnId !== "string") return;
      const turnId = typeof params.turnId === "string" ? params.turnId : entry.turn?.id;
      if (!turnId || entry.retiredTurns.has(turnId)) return;
      const phoneId = entry.nativeRequests.get(nativeTurnKey(params.requestId, turnId));
      const request = phoneId ? entry.hostRequests.get(phoneId) : undefined;
      // 此事件只说明请求已清理，不能据此推断已经批准。
      if (request) this.finishHostRequest(entry, request, "cancelled", null, false);
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
      const message = errorText(params.error) ?? "Codex 运行失败";
      // willRetry:true 是可重试错误（网络抖动重连等），不是本轮终态：
      // 立即 emit 会给手机一条假报错横幅，还会占掉唯一的终态错误名额，
      // 让随后 turn/completed 携带的真实失败原因被静默丢弃。只记录，留待收尾兜底。
      if (params.willRetry === true) { turn.lastRetryableError = safePreview(message); return; }
      if (!turn.errorEmitted) {
        turn.errorEmitted = true;
        this.emit(entry.id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: safePreview(message) });
      }
      // 不可重试的 error 也等待 turn/completed 再整轮收尾。
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
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = null;
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
    if (entry.failed && !turn.errorEmitted) {
      // 终态错误只发一条，且必须是真实失败原因：turn/completed 携带的 message 优先，
      // 缺失时才回落到本轮最后一次可重试错误文本（例如 "Reconnecting... 2/5"）。
      const message = errorText(error) ?? turn.lastRetryableError ?? "Codex 运行失败";
      this.emit(entry.id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: safePreview(message) });
    }
    this.emit(entry.id, { type: "status", status: entry.failed ? "error" : "idle" });
    this.emit(entry.id, { type: "agent_settled" });
    const next = entry.queue.shift();
    if (next) this.startTurn(entry, next);
    else this.touchIdle(entry);
  }

  private handleServerRequest(entry: DriverEntry, request: CodexServerRequest): void {
    const kind = serverRequestKind(request.method);
    const type = kind === "approval" ? APPROVAL_METHODS[request.method] : null;
    if (!kind) {
      // token 刷新 / attestation / 未知方法绝不转给手机（安全红线）；也不替未作答的用户选择任何选项。
      void entry.rpc.respondError(request.id, -32601, "This client does not support this server request").catch(() => undefined);
      return;
    }
    const params = isRecord(request.params) ? request.params : {};
    const turn = entry.turn;
    if (!entry.stopped && entry.ready && turn && turn.id === null && params.threadId === entry.id && typeof params.turnId === "string") {
      this.buffer(entry, turn, { kind: "request", value: request });
      return;
    }
    // 问答先归一化题面（脱敏 + 截断）；无法映射时不建卡不挂起，安全拒绝。
    let questions: HostUserQuestion[] | null = null;
    let elicitationTypes: Record<string, ElicitationValueType> = {};
    if (kind === "userInput") questions = parseUserInputQuestions(params);
    else if (kind === "elicitation") {
      const parsed = parseElicitationQuestions(params);
      if (parsed) { questions = parsed.questions; elicitationTypes = parsed.types; }
    }
    if (kind !== "approval" && !questions) {
      // 形状无法安全映射：requestUserInput 用 unsupported 让模型改文字提问；elicitation 保持现状 decline。
      if (kind === "userInput") void entry.rpc.respondError(request.id, -32601, "This client does not support interactive questions; the user has not answered or granted consent").catch(() => undefined);
      else void entry.rpc.respond(request.id, { action: "decline", content: null }).catch(() => undefined);
      return;
    }
    // 归属校验：审批与 requestUserInput 必须绑定当前 turn 的确切 id；
    // elicitation 的 params 只保证 message/requestedSchema，threadId/turnId 可能缺省 → 存在则必须匹配
    // （归属由本会话独占的 app-server 进程决定，缺省不放宽任何审批语义）。
    const threadOk = params.threadId === entry.id || (kind === "elicitation" && params.threadId === undefined);
    const turnIdOk = turn !== null && (params.turnId === turn.id || (kind === "elicitation" && params.turnId === undefined));
    const valid = !entry.stopped && entry.ready && turn && turn.id !== null && !turn.aborted
      && threadOk && turnIdOk && (kind !== "approval" || typeof params.itemId === "string");
    if (!valid) {
      // 未建卡就失效：未获回答的统一收尾，问答回 -32800（绝不代答），elicitation 保持现状 decline。
      this.replyRpc(entry, request.id, unansweredRpcReply(kind, type));
      return;
    }
    const native = nativeTurnKey(request.id, turn.id!);
    const previous = entry.nativeRequests.get(native);
    if (previous) {
      if (!entry.hostRequests.has(previous)) this.replyRpc(entry, request.id, unansweredRpcReply(kind, type));
      return;
    }
    const now = Date.now();
    const ttl = this.options.hostRequestTtlMs ?? 5 * 60_000;
    const id = `codex-host-${randomUUID()}`;
    const preview = kind === "approval"
      ? hostRequestPreview(type!, params, turn.approvalPreviews.get(params.itemId as string))
      : questionCardPreview(kind, questions!);
    const dto: HostRequestDto = {
      id, sessionId: entry.id, kind: kind === "approval" ? "permission" : "question",
      title: preview.title, detail: preview.detail, toolName: preview.toolName,
      ...(type ? { requestType: type } : {}),
      turnId: turn.id!, ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
      ...(kind === "approval" ? { allowAlways: false } : { questions: questions! }),
      createdAt: now, expiresAt: now + ttl,
    };
    const host: HostRequestEntry = {
      id, nativeId: request.id, kind, type, turnId: turn.id!,
      permissions: snapshotRequestedPermissions(params.permissions), elicitationTypes, dto,
      timer: setTimeout(() => this.finishHostRequest(entry, host, "timeout", null), ttl),
    };
    host.timer.unref?.();
    entry.hostRequests.set(id, host);
    entry.nativeRequests.set(native, id);
    const rawKey = nativeKey(request.id);
    const previousTurn = entry.nativeRequestTurns.get(rawKey);
    entry.nativeRequestTurns.set(rawKey, previousTurn === undefined || previousTurn === turn.id ? turn.id! : null);
    trimMap(entry.nativeRequests, 1_000);
    trimMap(entry.nativeRequestTurns, 1_000);
    this.touchTurn(entry);
    this.emit(entry.id, { type: "host_request", request: { ...dto } });
  }

  listHostRequests(id: string): HostRequestDto[] {
    return [...(this.drivers.get(id)?.hostRequests.values() ?? [])].map((request) => ({ ...request.dto }));
  }

  respondHostRequest(id: string, requestId: string, decision: CodexHostRequestDecision): boolean {
    const entry = this.drivers.get(id);
    const request = entry?.hostRequests.get(requestId);
    if (!entry || !request) return false;
    // 应答校验先行且不消费请求：非法 answers 一律 400 并保留卡片，让用户可以重新作答。
    let answers: Record<string, string[]> | null = null;
    let outcome: "allow" | "deny";
    if ("answers" in decision) {
      if (request.kind === "approval") throw new HubError(ErrorCodes.INVALID_REQUEST, "该请求是审批卡，请用 outcome 应答");
      validateQuestionAnswers(request.dto.questions ?? [], decision.answers);
      answers = decision.answers;
      outcome = "allow";
    } else {
      if (decision.outcome !== "allow" && decision.outcome !== "deny") throw new HubError(ErrorCodes.INVALID_REQUEST, "outcome 必须为 allow|deny");
      if (decision.outcome === "allow" && request.kind !== "approval") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "问答请求请提交 answers（或 outcome:deny 拒绝回答）");
      }
      outcome = decision.outcome;
    }
    const current = entry.ready && !entry.stopped && entry.turn?.id === request.turnId && !entry.turn.aborted;
    const expired = (request.dto.expiresAt ?? 0) <= Date.now();
    if (!current || expired) {
      // 应答时 turn 已失效/已超时：一律按未回答收尾（问答回 -32800），绝不冒充用户回答。
      this.finishHostRequest(entry, request, expired ? "timeout" : "cancelled", null);
      return false;
    }
    if (answers !== null) {
      const reply: CodexRpcReply = request.kind === "userInput"
        ? { result: buildUserInputResult(answers) }
        : { result: buildElicitationAccept(request.elicitationTypes, answers) };
      this.finishHostRequest(entry, request, "allow", reply);
      return true;
    }
    if (outcome === "deny") {
      this.finishHostRequest(entry, request, "deny", declinedRpcReply(request.kind, request.type, request.permissions));
      return true;
    }
    this.finishHostRequest(entry, request, "allow", { result: buildApprovalResult(request.type!, "allow", request.permissions) });
    return true;
  }

  /**
   * 移除卡片并发送 rpc 应答。reply=null 表示未获用户回答（TTL 超时/turn 失效/清理）：
   * 按请求类型给安全收尾（问答回 -32800、elicitation decline、审批 cancel），绝不代答。
   */
  private finishHostRequest(entry: DriverEntry, request: HostRequestEntry, outcome: HostRequestOutcome, reply: CodexRpcReply | null, send = true): void {
    if (entry.hostRequests.get(request.id) !== request) return;
    clearTimeout(request.timer);
    entry.hostRequests.delete(request.id);
    // 审批有动作（含超时/取消）也算本轮活动，避免 watchdog 把刚回答的轮次当成停滞。
    this.touchTurn(entry);
    this.resolvedHostRequests.set(request.id, Date.now() + RESOLVED_TTL_MS);
    trimMap(this.resolvedHostRequests, 200);
    if (send) {
      const payload = reply ?? unansweredRpcReply(request.kind, request.type, request.permissions, outcome === "cancelled");
      const pending = "rpcError" in payload
        ? entry.rpc.respondError(request.nativeId, payload.rpcError.code, payload.rpcError.message)
        : entry.rpc.respond(request.nativeId, payload.result);
      void pending.catch((error: unknown) => {
        if (!entry.stopped) this.failEntry(entry, asError(error));
      });
    }
    this.emit(entry.id, { type: "host_request_resolved", requestId: request.id, outcome });
  }

  /** 安全拒绝通道：未建卡/缓冲清理时直接回安全结果，失败不拉胯整个进程。 */
  private replyRpc(entry: DriverEntry, id: CodexRpcId, reply: CodexRpcReply): void {
    const pending = "rpcError" in reply
      ? entry.rpc.respondError(id, reply.rpcError.code, reply.rpcError.message)
      : entry.rpc.respond(id, reply.result);
    void pending.catch(() => undefined);
  }

  isResolvedHostRequest(requestId: string, now = Date.now()): boolean {
    const expires = this.resolvedHostRequests.get(requestId);
    if (expires === undefined) return false;
    if (expires <= now) { this.resolvedHostRequests.delete(requestId); return false; }
    return true;
  }

  private rejectHostRequests(entry: DriverEntry, outcome: "timeout" | "cancelled"): void {
    for (const request of [...entry.hostRequests.values()]) this.finishHostRequest(entry, request, outcome, null);
    const buffered = entry.turn?.buffered ?? [];
    for (const item of buffered) {
      if (item.kind === "request") {
        const kind = serverRequestKind(item.value.method);
        if (kind) this.replyRpc(entry, item.value.id, unansweredRpcReply(kind, kind === "approval" ? APPROVAL_METHODS[item.value.method] : null));
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

  private stopEntry(entry: DriverEntry, reason: string, failed: boolean, announce = true): void {
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
      turn.interruptTimer = null;
      if (turn.watchdog) clearTimeout(turn.watchdog);
      turn.watchdog = null;
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
    if (announce) this.emit(entry.id, { type: "attach_state", attached: false, terminalOnline: false, source: "codex" });
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
/** 提取 codex 错误载荷里的可读原因；缺失时返回 null，便于按优先级回落。 */
function errorText(value: unknown): string | null {
  const message = isRecord(value) ? value.message : value;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}
/** 写者互斥以协议错误码为准；codex 改措辞时仍能识别。 */
function isWriterConflict(error: unknown): boolean {
  return error instanceof CodexRpcError && error.code === RPC_INVALID_REQUEST;
}
const WRITER_CONFLICT_RE = /active writer|already.*writer|writer.*(?:held|active|busy)|thread.*already.*(?:active|running)/i;
function attachError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  const message = safePreview(asError(error).message);
  // 先判错误码（-32600 = invalid request，codex 用它表达线程已被其它客户端持有），
  // 文案正则只作旧版本/改措辞时的兜底。
  if (isWriterConflict(error) || WRITER_CONFLICT_RE.test(message)) {
    return new HubError(ErrorCodes.SESSION_BUSY, `Codex 会话正由其他客户端占用：${message}`, 409);
  }
  return unavailable(`Codex 接管不可用：${message}`);
}
function isTransportFailure(error: unknown): boolean { return error instanceof CodexRpcError && typeof error.code === "string"; }
function commandFailure(error: unknown): string {
  const message = safePreview(asError(error).message);
  if (isWriterConflict(error)) return `Codex 会话正由其他客户端占用，请先在电脑端退出该会话后重试：${message}`;
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

/** 不以“已经发出 kill”冒充 writer 已释放；超时仍保留 busy 条目。 */
function waitForDriverRelease(entry: DriverEntry): Promise<void> {
  if (entry.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(unavailable("Codex 写者尚未释放，请稍后重试")); }, KILL_GRACE_MS + 1_000);
    const cleanup = () => { clearTimeout(timer); entry.child.off("close", done); entry.child.off("exit", done); };
    entry.child.once("close", done); entry.child.once("exit", done);
  });
}
