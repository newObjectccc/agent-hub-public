/**
 * 终端 pi 反向指令通道中枢（E3 双模式会话驱动）。
 *
 * - 心跳：扩展每 30s POST /api/agents/heartbeat 注册"终端 pi 在线"（90s 无心跳判定离线）
 * - 指令队列：attach 模式下 web 发的消息进队列；扩展经 GET /api/agents/commands 长轮询取走
 * - 回执：扩展执行后 POST /api/agents/ack（成功/失败原因），幂等去重，命令级 commandId 防重复注入
 * - 超时保护：投递后 30s 未回执自动重投（同 commandId，扩展按 id 幂等），最多 3 次；
 *   队列指令 10 分钟 TTL 过期丢弃；attach 会话心跳超时自动失效（attach_state 广播）
 *
 * 冲突保护：attach 生效期间同会话的 parallel 发送（/prompt）由路由层拒绝（ATTACH_ACTIVE），
 * 防止 server 内 SDK 实例与终端 pi 进程双写同一会话文件。
 */
import { randomBytes } from "node:crypto";
import { ErrorCodes, HubError } from "./errors.js";
import type { ServerEvent, TerminalAttachInfo } from "./types.js";

export type CommandMode = "prompt" | "steer" | "followUp";

export const COMMAND_MODES: readonly CommandMode[] = ["prompt", "steer", "followUp"];

/** 心跳有效期：超过此时长无心跳 → 终端离线（任务硬性要求 90s） */
export const HEARTBEAT_TTL_MS = 90_000;
/**
 * 扩展轮询活性窗口：超过此时长没来 poll 过 → 认为扩展已不再取指令。
 *
 * 为何需要它（而不是只靠心跳）：心跳 TTL 是 90s，终端关掉后的整整 90s 里
 * `isOnline` 仍为 true → attach 会「成功」、前端自动接管并提示“终端在线，已默认接管终端”，
 * 但消息入队后根本没人取：用户要等 60s 才看到一条提示、再等 detach 把指令取消，
 * 而那条消息既不入离线队列也不回落平行模式——输入框已清空，文本彻底消失（实测踩坑）。
 * 长轮询上限是 30s（MAX_POLL_WAIT_MS），扩展活着就必然每 ≤30s 来一次，45s = 30s + 容差。
 */
export const POLL_TTL_MS = 45_000;
/** 心跳上报间隔（扩展侧 30s，server 只作日志/诊断参考） */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 队列指令 TTL：入队 10 分钟未投递/未完成 → 过期丢弃 */
export const COMMAND_TTL_MS = 10 * 60_000;
/** 投递后未回执的重投时限 */
export const ACK_TIMEOUT_MS = 30_000;
/** 单条指令最大投递次数（含首次） */
export const MAX_ATTEMPTS = 3;
/** 单会话队列上限 */
export const MAX_QUEUE = 50;
/** 单次长轮询最多返回条数 */
export const MAX_POLL_BATCH = 10;
/** 长轮询等待上限（毫秒） */
export const MAX_POLL_WAIT_MS = 30_000;

export interface AgentInfo {
  sessionId: string;
  pid: number | null;
  cwd: string;
  capabilities: string[];
  /** 最近一次心跳（ms） */
  lastSeen: number;
}

export interface AttachCommand {
  id: string;
  kind: "message";
  text: string;
  mode: CommandMode;
  enqueuedAt: number;
  expiresAt: number;
  /** 已投递次数（首次投递为 1） */
  attempts: number;
  /** 客户端幂等键（重复 POST 同 key 不重复入队） */
  clientMessageId: string | null;
}

export interface AckResult {
  commandId: string;
  ok: boolean;
  error: string | null;
  at: number;
}

export interface EnqueueInput {
  text: string;
  mode?: unknown;
  clientMessageId?: unknown;
}

export interface HeartbeatInput {
  sessionId: string;
  pid?: unknown;
  cwd?: unknown;
  capabilities?: unknown;
}

/** 路由/测试注入用结构接口 */
export interface AgentLinkLike {
  heartbeat(input: HeartbeatInput, now?: number): { ttlMs: number };
  isOnline(sessionId: string, now?: number): boolean;
  listAgents(): AgentInfo[];
  attach(sessionId: string, now?: number): AgentInfo;
  detach(sessionId: string): boolean;
  isAttached(sessionId: string, now?: number): boolean;
  enqueue(sessionId: string, input: EnqueueInput, now?: number): AttachCommand;
  poll(sessionId: string, waitMs: number, now?: number): Promise<AttachCommand[]>;
  ack(sessionId: string, commandId: string, ok: boolean, error?: string, now?: number): AckResult | null;
  statusFor(sessionId: string, now?: number): TerminalAttachInfo;
}

interface InflightEntry {
  command: AttachCommand;
  timer: ReturnType<typeof setTimeout>;
}

interface AttachedState {
  attachedAt: number;
  queue: AttachCommand[];
  inflight: Map<string, InflightEntry>;
  /** 挂起的长轮询（enqueue/detach 时唤醒） */
  waiters: Set<() => void>;
  /** clientMessageId → commandId（重复提交保护） */
  byClient: Map<string, string>;
  /** 已回执记录（ack 幂等；有界保留最近 100 条） */
  acks: Map<string, AckResult>;
}

export interface AgentCommandHubOptions {
  /** 投递后未回执的重投时限（测试可注入短值） */
  ackTimeoutMs?: number;
  /** 队列指令 TTL（测试可注入短值） */
  commandTtlMs?: number;
}

function parseMode(raw: unknown): CommandMode {
  if (typeof raw === "string" && (COMMAND_MODES as readonly string[]).includes(raw)) return raw as CommandMode;
  throw new HubError(ErrorCodes.INVALID_REQUEST, `mode 必须是 prompt|steer|followUp 之一`);
}

/** clientMessageId 幂等缓存 TTL（覆盖"完成后重复提交"窗口） */
export const CLIENT_IDEMPOTENT_TTL_MS = 10 * 60_000;

export class AgentCommandHub implements AgentLinkLike {
  private readonly agents = new Map<string, AgentInfo>();
  /** 扩展最后一次长轮询的时刻（活性打点，比心跳 TTL 硬：见 POLL_TTL_MS 注释） */
  private readonly lastPollAt = new Map<string, number>();
  private readonly attached = new Map<string, AttachedState>();
  /** clientMessageId → commandId 全局幂等缓存（TTL 清理；不随 attach state 生灭——防重复注入） */
  private readonly clientSeen = new Map<string, { commandId: string; at: number }>();
  private readonly emit: ((sessionId: string, event: ServerEvent) => void) | undefined;
  private readonly ackTimeoutMs: number;
  private readonly commandTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(emit?: (sessionId: string, event: ServerEvent) => void, options: AgentCommandHubOptions = {}) {
    this.emit = emit;
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.commandTtlMs = options.commandTtlMs ?? COMMAND_TTL_MS;
  }

  /** 启动周期清扫（30s，unref）：离线 attach 自动失效 + 过期队列清理；测试可直接调 sweep */
  startSweep(intervalMs = 30_000): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  close(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [id] of [...this.attached]) this.detach(id);
  }

  // ---- 心跳 / 在线判定 ----

  heartbeat(input: HeartbeatInput, now = Date.now()): { ttlMs: number } {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (sessionId === "" || sessionId.length > 256) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "sessionId 非法");
    }
    const pid = typeof input.pid === "number" && Number.isFinite(input.pid) ? Math.floor(input.pid) : null;
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    const capabilities = Array.isArray(input.capabilities)
      ? input.capabilities.filter((c): c is string => typeof c === "string").slice(0, 16)
      : [];
    const prev = this.agents.get(sessionId);
    this.agents.set(sessionId, {
      sessionId,
      pid: pid ?? prev?.pid ?? null,
      cwd: cwd !== "" ? cwd : prev?.cwd ?? "",
      capabilities: capabilities.length > 0 ? capabilities : prev?.capabilities ?? [],
      lastSeen: now,
    });
    return { ttlMs: HEARTBEAT_TTL_MS };
  }

  isOnline(sessionId: string, now = Date.now()): boolean {
    const info = this.agents.get(sessionId);
    return info !== undefined && now - info.lastSeen <= HEARTBEAT_TTL_MS;
  }

  /**
   * 扩展是否仍在轮询取指令（比心跳更硬的活性信号）。
   *
   * 宽容原则：**从未 poll 过**（undefined）时返回 true——可能是扩展刚启动还没发第一次
   * 长轮询，也可能是老版本扩展；这两种情况不该被误判为死终端而拒接管。
   * 只有「poll 过、但已超过 POLL_TTL_MS 没再来」才判 false（终端进程大概率已退出）。
   */
  isResponsive(sessionId: string, now = Date.now()): boolean {
    const lastPoll = this.lastPollAt.get(sessionId);
    if (lastPoll === undefined) return true;
    return now - lastPoll <= POLL_TTL_MS;
  }

  listAgents(): AgentInfo[] {
    return [...this.agents.values()];
  }

  // ---- attach / detach ----

  attach(sessionId: string, now = Date.now()): AgentInfo {
    const info = this.agents.get(sessionId);
    if (!info || !this.isOnline(sessionId, now)) {
      throw new HubError(
        ErrorCodes.ATTACH_UNAVAILABLE,
        "终端 pi 不在线：请在电脑终端打开带 pi-command 扩展的 pi 会话（心跳 90s 内）",
        409,
      );
    }
    // 心跳还在但扩展已停止轮询（典型：刚关掉终端，心跳要 90s 才过期）——
    // 这时接管必然变成「假接管」：消息入队无人取，用户等一分钟才知道、文本还会丢。
    // 立即拒并给出两条明确出路，比让用户干等强得多。
    if (!this.isResponsive(sessionId, now)) {
      throw new HubError(
        ErrorCodes.ATTACH_UNAVAILABLE,
        "终端心跳还在但扩展已停止取指令（通常是电脑终端刚关闭）。请在电脑上重新打开该会话，或改用 📱 平行继续由 server 直接执行。",
        409,
      );
    }
    let state = this.attached.get(sessionId);
    if (!state) {
      state = {
        attachedAt: now,
        queue: [],
        inflight: new Map(),
        waiters: new Set(),
        byClient: new Map(),
        acks: new Map(),
      };
      this.attached.set(sessionId, state);
      this.emit?.(sessionId, { type: "attach_state", attached: true, terminalOnline: true });
    }
    return info;
  }

  detach(sessionId: string): boolean {
    const state = this.attached.get(sessionId);
    if (!state) return false;
    this.attached.delete(sessionId);
    for (const entry of state.inflight.values()) clearTimeout(entry.timer);
    state.inflight.clear();
    // 未投递指令视为取消（回执失败原因，前端状态条可见）
    for (const cmd of state.queue) {
      this.pushAck(sessionId, state, { commandId: cmd.id, ok: false, error: "已退出接管模式，指令取消", at: Date.now() });
    }
    state.queue.length = 0;
    this.wakeAll(state);
    this.emit?.(sessionId, { type: "attach_state", attached: false, terminalOnline: this.isOnline(sessionId) });
    return true;
  }

  isAttached(sessionId: string, now = Date.now()): boolean {
    const state = this.attached.get(sessionId);
    if (!state) return false;
    // 心跳超时 → attach 自动失效（懒判定；sweep 也会兜底）
    if (!this.isOnline(sessionId, now)) {
      this.detach(sessionId);
      return false;
    }
    return true;
  }

  /** 会话列表徽章数据（终端在线 / 已接管 / 扩展是否在取指令） */
  statusFor(sessionId: string, now = Date.now()): TerminalAttachInfo {
    return {
      online: this.isOnline(sessionId, now),
      attached: this.isAttached(sessionId, now),
      // 下发轮询活性：前端据此决定要不要「自动接管」（心跳还在但扩展已停轮询时
      // 自动接管 = 假接管，消息入队无人取）；用户手动选接管仍允许，不剥夺选择权
      responsive: this.isResponsive(sessionId, now),
    };
  }

  // ---- 指令队列 ----

  enqueue(sessionId: string, input: EnqueueInput, now = Date.now()): AttachCommand {
    const state = this.attached.get(sessionId);
    if (!state || !this.isAttached(sessionId, now)) {
      throw new HubError(ErrorCodes.ATTACH_REQUIRED, "该会话未处于接管模式（终端未 attach）", 409);
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    // 扩展已停止轮询（典型：attach 之后用户才关掉终端）：立即失败，不入队。
    // 否则这条消息会在队列里等 30s×3 次重投 + 10min TTL，而前端要 60s 才给一条
    // 「消息已入终端队列」的小字提示——用户以为发出去了，实际永远不会执行。
    // 文案必须明说「没有发出去」，前端据此把文本退回离线队列（绝不静默丢消息）。
    if (!this.isResponsive(sessionId, now)) {
      throw new HubError(
        ErrorCodes.ATTACH_UNAVAILABLE,
        "终端扩展已停止取指令（电脑终端可能刚关闭）：这条消息没有发出去。已切回 📱 平行继续，重发即可。",
        409,
      );
    }
    const mode = parseMode(input.mode ?? "prompt");
    const clientMessageId =
      typeof input.clientMessageId === "string" && input.clientMessageId.trim() !== ""
        ? input.clientMessageId.trim().slice(0, 128)
        : null;

    // 重复提交保护：同 clientMessageId 幂等返回既有指令（全局 TTL 缓存，指令完成后仍有效）
    if (clientMessageId !== null) {
      const seen = this.clientSeen.get(clientMessageId);
      if (seen !== undefined && now - seen.at < CLIENT_IDEMPOTENT_TTL_MS) {
        const existing = state.inflight.get(seen.commandId)?.command ?? state.acks.get(seen.commandId) ? { id: seen.commandId } : null;
        if (existing) return { commandId: seen.commandId, deduped: true } as never;
      }
      const existingId = state.byClient.get(clientMessageId);
      if (existingId !== undefined) {
        const existing = this.findCommand(state, existingId);
        if (existing) return existing;
      }
    }

    // 过期清理后判上限
    this.dropExpired(sessionId, state, now);
    if (state.queue.length + state.inflight.size >= MAX_QUEUE) {
      throw new HubError(ErrorCodes.ATTACH_QUEUE_FULL, `指令队列已满（${MAX_QUEUE}），稍后再试`, 409);
    }

    const command: AttachCommand = {
      id: `cmd-${randomBytes(8).toString("hex")}`,
      kind: "message",
      text,
      mode,
      enqueuedAt: now,
      expiresAt: now + this.commandTtlMs,
      attempts: 0,
      clientMessageId,
    };
    state.queue.push(command);
    if (clientMessageId !== null) {
      state.byClient.set(clientMessageId, command.id);
      this.clientSeen.set(clientMessageId, { commandId: command.id, at: now });
    }
    this.wakeAll(state);
    return command;
  }

  /**
   * 长轮询取指令：有队列立即返回（移入 inflight，30s 未回执自动重投）；
   * 否则挂起至 enqueue/detach/超时。waitMs=0 时为短轮询（立即返回）。
   */
  async poll(sessionId: string, waitMs: number, now = Date.now()): Promise<AttachCommand[]> {
    // 活性打点（无条件，包括未 attach 的空转轮询）：attach/enqueue 据此识别“终端真的还在吗”
    this.lastPollAt.set(sessionId, now);
    const state = this.attached.get(sessionId);
    if (!state) {
      // 未 attach（终端在线未接管稳态）：挂起到轮询上限再空返——防客户端热空转（实测 6000 req/s 的根因）
      const wait = Math.max(0, Math.min(Math.floor(waitMs), MAX_POLL_WAIT_MS));
      if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
      return [];
    }
    this.dropExpired(sessionId, state, now);
    if (state.queue.length === 0) {
      const wait = Math.max(0, Math.min(Math.floor(waitMs), MAX_POLL_WAIT_MS));
      if (wait === 0) return [];
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          state.waiters.delete(waiter);
          resolve();
        };
        const timer = setTimeout(waiter, wait);
        timer.unref?.();
        state.waiters.add(waiter);
        // enqueue/detach/clear 时唤醒
      }).then(() => undefined);
      if (!this.attached.has(sessionId)) return [];
      this.dropExpired(sessionId, state, Date.now());
    }
    const batch = state.queue.splice(0, MAX_POLL_BATCH);
    const out: AttachCommand[] = [];
    for (const command of batch) {
      command.attempts += 1;
      const timer = setTimeout(() => this.onAckTimeout(sessionId, command.id), this.ackTimeoutMs);
      timer.unref?.();
      state.inflight.set(command.id, { command, timer });
      out.push(command);
    }
    return out;
  }

  /** 执行结果回执（幂等：同 commandId 重复 ack 返回首条结果） */
  ack(sessionId: string, commandId: string, ok: boolean, error?: string, now = Date.now()): AckResult | null {
    const state = this.attached.get(sessionId);
    if (!state) return null;
    const previous = state.acks.get(commandId);
    if (previous) return previous;
    const entry = state.inflight.get(commandId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    state.inflight.delete(commandId);
    const result: AckResult = {
      commandId,
      ok,
      error: typeof error === "string" && error.trim() !== "" ? error.trim().slice(0, 500) : null,
      at: now,
    };
    this.pushAck(sessionId, state, result);
    return result;
  }

  /** 周期清扫：离线 attach 失效 + 过期队列丢弃（带原因回执）+ clientSeen 过期清理 */
  sweep(now = Date.now()): void {
    for (const [sessionId, state] of [...this.attached]) {
      if (!this.isOnline(sessionId, now)) {
        this.detach(sessionId);
        continue;
      }
      this.dropExpired(sessionId, state, now);
    }
    for (const [staleId, info] of [...this.agents]) {
      if (now - info.lastSeen > HEARTBEAT_TTL_MS * 4) this.agents.delete(staleId);
    }
    // 轮询打点同步淘汰（防无界增长）：比心跳存得更久没意义，心跳条目清了就没谁再读它
    for (const [staleId, at] of [...this.lastPollAt]) {
      if (now - at > HEARTBEAT_TTL_MS * 4) this.lastPollAt.delete(staleId);
    }
    // clientMessageId 幂等缓存过期清理（OOM 审计 AC5）：TTL 内保留防重复注入，过期即删
    for (const [clientKey, seen] of [...this.clientSeen]) {
      if (now - seen.at >= CLIENT_IDEMPOTENT_TTL_MS) this.clientSeen.delete(clientKey);
    }
  }

  // ---- 内部 ----

  private findCommand(state: AttachedState, id: string): AttachCommand | undefined {
    const queued = state.queue.find((c) => c.id === id);
    if (queued) return queued;
    return state.inflight.get(id)?.command;
  }

  private dropExpired(sessionId: string, state: AttachedState, now: number): void {
    const keep: AttachCommand[] = [];
    for (const cmd of state.queue) {
      if (cmd.expiresAt <= now) {
        this.pushAck(sessionId, state, { commandId: cmd.id, ok: false, error: "指令超时未投递，已丢弃", at: now });
        if (cmd.clientMessageId !== null) state.byClient.delete(cmd.clientMessageId);
      } else {
        keep.push(cmd);
      }
    }
    state.queue = keep;
  }

  private onAckTimeout(sessionId: string, commandId: string): void {
    const state = this.attached.get(sessionId);
    if (!state) return;
    const entry = state.inflight.get(commandId);
    if (!entry) return;
    state.inflight.delete(commandId);
    const cmd = entry.command;
    if (cmd.attempts >= MAX_ATTEMPTS || cmd.expiresAt <= Date.now()) {
      this.pushAck(sessionId, state, {
        commandId: cmd.id,
        ok: false,
        error: `回执超时（已投递 ${cmd.attempts} 次），指令丢弃`,
        at: Date.now(),
      });
      return;
    }
    // 重投（同 commandId，扩展按 id 幂等防重复注入）
    state.queue.unshift(cmd);
    this.wakeAll(state);
  }

  private pushAck(sessionId: string, state: AttachedState, result: AckResult): void {
    state.acks.set(result.commandId, result);
    // 有界保留：超出 100 条淘汰最旧
    if (state.acks.size > 100) {
      const oldest = state.acks.keys().next();
      if (!oldest.done) state.acks.delete(oldest.value);
    }
    // 回执经 WS 回流（web 状态条："终端已收到 ✓ / 注入失败：<原因>"）
    this.emit?.(sessionId, {
      type: "command_ack",
      commandId: result.commandId,
      ok: result.ok,
      error: result.error,
    });
  }

  private wakeAll(state: AttachedState): void {
    for (const waiter of [...state.waiters]) waiter();
  }
}
