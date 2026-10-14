/**
 * ClaudeDriverHub：claude 会话的「hub 驱动接管」核心（E2/E3/E4 实测契约见 docs/CLAUDE_DRIVER.md）。
 *
 * 形态：attach 期间为会话持有长驻
 *   `claude -p --resume <id> --input-format stream-json --output-format stream-json ...` 进程；
 * 手机消息经 stdin 注入 = 真用户 turn（E3：工具间隙转向 = 真 steer；result 后 = 新 turn）；
 * 权限请求经 --permission-prompt-tool MCP bridge 回连（E2），手机批/拒后回注 PermissionResult；
 * abort = control interrupt（E4：turn 收尾、进程存活）；detach 后 `claude --resume` 无缝接回。
 *
 * 与 pi 的 AgentCommandHub 平行：pi 靠扩展心跳+指令队列；这里 hub 自持进程（在线=进程存活）。
 * command_ack 语义对齐 pi：stdin 写成功即「终端已接收」；prompt 忙时走失败回执（与 pi-command 同）。
 *
 * 安全约束（与 ClaudeAdapter 文件头一致的底线）：
 * - spawn 固定安全集，绝不传 --dangerously-skip-permissions / --allowedTools / --bare；
 * - 权限应答永不自动 allow（超时/异常一律 deny）；
 * - 异常静默隔离，绝不拖垮 hub 主进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ErrorCodes, HubError } from "../errors.js";
import type { HostRequestDto, ServerEvent, TerminalAttachInfo } from "../types.js";
import { ClaudeStreamTranslator } from "./claude-stream.js";
import { mergeClaudeEnv } from "./claude-env.js";
import {
  buildDriverArgs,
  encodeInterrupt,
  encodeUserMessage,
  hostRequestTitle,
  parseDriverMode,
  ENV_LIVE_TOKEN,
  ENV_LIVE_URL,
  ENV_SESSION_ID,
  type BridgeHostRequestBody,
  type PermissionBehavior,
} from "./claude-host-protocol.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;

/** 与 agents.ts CommandMode 同语义 */
export type DriverCommandMode = "prompt" | "steer" | "followUp";

export interface DriverCommand {
  id: string;
  mode: DriverCommandMode;
}

export interface HostRequestDecision {
  behavior: PermissionBehavior;
  message: string;
}

/** 路由/测试注入用结构接口（对齐 agents.ts AgentLinkLike 风格） */
export interface ClaudeDriverLinkLike {
  attach(
    id: string,
    opts: { cwd: string; sessionFile: string },
    now?: number,
  ): Promise<{ attached: true; driver: "hub"; mirror: boolean }>;
  detach(id: string): boolean;
  isAttached(id: string, now?: number): boolean;
  send(id: string, input: { text: unknown; mode?: unknown; clientMessageId?: unknown }): DriverCommand;
  abortTurn(id: string): void;
  statusFor(id: string, now?: number): TerminalAttachInfo;
  /** bridge 注册权限请求并挂起等人工应答（超时/收尾一律 deny） */
  registerHostRequest(body: BridgeHostRequestBody, now?: number): Promise<HostRequestDecision>;
  listHostRequests(id: string): HostRequestDto[];
  respondHostRequest(id: string, requestId: string, decision: HostRequestDecision): boolean;
  startSweep(): void;
  disposeAll(): void;
}

export interface ClaudeDriverOptions {
  emit: EmitFn;
  /** hub 自身回环地址（bridge 回连用） */
  liveUrl: string;
  /** auth.token（非空时 bridge 带 Bearer） */
  liveToken?: string;
  /** bridge 脚本绝对路径（integrations/claude-perm-bridge/bridge.mjs） */
  bridgeScriptPath: string;
  claudeBin?: string;
  /** 并发 driver 上限 */
  maxConcurrent?: number;
  /** 空闲自动 detach 时长（0 = 永不；turn 进行中不 detach） */
  idleDetachMs?: number;
  /** attach 前 sessionFile 静默窗（外部写入检测，防双写） */
  externalQuietMs?: number;
  /** 权限请求人工应答超时（超时一律 deny，绝不自动 allow） */
  hostRequestTtlMs?: number;
  /** 测试注入 */
  spawnFn?: typeof spawn;
  /** 测试注入：settings 探测（返回 settings JSON 或 null） */
  readSettings?: (sessionCwd: string) => Promise<unknown>;
  /** 终端投屏（D7）：tmux 命名 pane；off/无 tmux 时静默降级 mirror:false */
  mirror?: "tmux" | "off";
  /** 测试注入：投屏启停（缺省走 claude-mirror 真实现） */
  startMirror?: (sessionId: string, sessionFile: string) => Promise<boolean>;
  stopMirror?: (sessionId: string) => void;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_IDLE_DETACH_MS = 30 * 60_000;
const DEFAULT_EXTERNAL_QUIET_MS = 3_000;
const DEFAULT_HOST_REQUEST_TTL_MS = 5 * 60_000;
const KILL_GRACE_MS = 2_000;
const STDERR_PREVIEW_LIMIT = 500;
/** clientMessageId 幂等缓存 TTL（对齐 agents.ts） */
const CLIENT_IDEMPOTENT_TTL_MS = 10 * 60_000;

interface QueuedMessage {
  commandId: string;
  text: string;
  mode: DriverCommandMode;
}

interface HostRequestEntry {
  sessionId: string;
  requestId: string;
  toolName: string;
  title: string;
  detail: string | null;
  input: unknown;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: HostRequestDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DriverEntry {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  child: ChildProcess;
  translator: ClaudeStreamTranslator;
  turnActive: boolean;
  queue: QueuedMessage[];
  hostRequests: Map<string, HostRequestEntry>;
  /** clientMessageId → commandId */
  byClient: Map<string, string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  intentionalStop: boolean;
  stderrTail: string;
  mirror: boolean;
}

export class ClaudeDriverHub {
  private readonly emit: EmitFn;
  private readonly liveUrl: string;
  private readonly liveToken: string;
  private readonly bridgeScriptPath: string;
  private readonly claudeBin: string;
  private readonly maxConcurrent: number;
  private readonly idleDetachMs: number;
  private readonly externalQuietMs: number;
  private readonly hostRequestTtlMs: number;
  private readonly spawnFn: typeof spawn;
  private readonly readSettings: (sessionCwd: string) => Promise<unknown>;
  private readonly mirrorMode: "tmux" | "off";
  private readonly startMirrorFn: (sessionId: string, sessionFile: string) => Promise<boolean>;
  private readonly stopMirrorFn: (sessionId: string) => void;
  private readonly drivers = new Map<string, DriverEntry>();
  /** 全局 clientMessageId 幂等（跨 attach 生命周期，防完成后重复注入） */
  private readonly clientSeen = new Map<string, { commandId: string; at: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: ClaudeDriverOptions) {
    this.emit = options.emit;
    this.liveUrl = options.liveUrl;
    this.liveToken = options.liveToken ?? "";
    this.bridgeScriptPath = options.bridgeScriptPath;
    this.claudeBin = options.claudeBin ?? "claude";
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.idleDetachMs = options.idleDetachMs ?? DEFAULT_IDLE_DETACH_MS;
    this.externalQuietMs = options.externalQuietMs ?? DEFAULT_EXTERNAL_QUIET_MS;
    this.hostRequestTtlMs = options.hostRequestTtlMs ?? DEFAULT_HOST_REQUEST_TTL_MS;
    this.spawnFn = options.spawnFn ?? spawn;
    this.readSettings = options.readSettings ?? defaultReadSettings;
    this.mirrorMode = options.mirror ?? "tmux";
    this.startMirrorFn =
      options.startMirror ??
      (async (sid, sfile) => {
        if (this.mirrorMode === "off") return false;
        const mod = await import("./claude-mirror.js");
        if (!(await mod.hasTmux())) return false;
        return (await mod.startMirror(sid, sfile)) !== null;
      });
    this.stopMirrorFn =
      options.stopMirror ??
      ((sid) => {
        if (this.mirrorMode === "off") return;
        void import("./claude-mirror.js").then((mod) => mod.stopMirror(sid));
      });
  }

  // ---- 生命周期 ----

  /** attach：启动（或幂等复用）驱动进程。attach 前做外部写入静默窗检查（防双写）。 */
  async attach(id: string, opts: { cwd: string; sessionFile: string }, now = Date.now()): Promise<{ attached: true; driver: "hub"; mirror: boolean }> {
    this.ensureAlive();
    const existing = this.drivers.get(id);
    if (existing && !existing.child.killed) {
      return { attached: true, driver: "hub", mirror: existing.mirror };
    }
    if (this.drivers.size >= this.maxConcurrent) {
      throw new HubError(ErrorCodes.DRIVER_LIMIT, `接管进程已达上限（${this.maxConcurrent}），请先退出其他接管会话`, 409);
    }
    // 防双写：外部（终端 TUI）近期仍在写 transcript → 拒绝接管
    try {
      const st = await stat(opts.sessionFile);
      if (now - st.mtimeMs < this.externalQuietMs) {
        throw new HubError(
          ErrorCodes.ATTACH_UNAVAILABLE,
          "电脑端正在写入该会话（可能仍在执行），请稍候再接管",
          409,
        );
      }
    } catch (err) {
      if (err instanceof HubError) throw err;
      // stat 失败（文件暂缺）不拦截：--resume 由 claude 自己报错，路由层已有 findSession 前置
    }

    const settings = await this.readSettings(opts.cwd).catch(() => null);
    const bypass = settings !== null && isBypass(settings);
    const args = buildDriverArgs({
      sessionId: id,
      // bypass 环境不产生权限请求（E2 实测），bridge 可不挂；非 bypass 挂 bridge 走手机批权限
      bridgeScriptPath: bypass ? null : this.bridgeScriptPath,
    });
    const env: NodeJS.ProcessEnv = {
      ...(await mergeClaudeEnv(process.env)),
      [ENV_SESSION_ID]: id,
      [ENV_LIVE_URL]: this.liveUrl,
    };
    if (this.liveToken !== "") env[ENV_LIVE_TOKEN] = this.liveToken;

    const child = this.spawnFn(this.claudeBin, args, {
      cwd: opts.cwd !== "" ? opts.cwd : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    const entry: DriverEntry = {
      sessionId: id,
      cwd: opts.cwd,
      sessionFile: opts.sessionFile,
      child,
      translator: new ClaudeStreamTranslator(),
      turnActive: false,
      queue: [],
      hostRequests: new Map(),
      byClient: new Map(),
      idleTimer: null,
      intentionalStop: false,
      stderrTail: "",
      mirror: false,
    };
    this.drivers.set(id, entry);
    this.bindChild(entry);
    this.touchIdle(entry);
    // 投屏（D7）：异步拉起 tmux pane，失败静默降级 mirror:false（不影响接管本身）
    this.startMirrorFn(id, opts.sessionFile)
      .then((ok) => {
        entry.mirror = ok;
      })
      .catch(() => undefined);
    this.emit(id, { type: "attach_state", attached: true, terminalOnline: true });
    return { attached: true, driver: "hub", mirror: entry.mirror };
  }

  /** detach：停驱动进程（SIGTERM→SIGKILL）；未投递队列回执失败；挂起权限请求一律 deny 收尾 */
  detach(id: string): boolean {
    const entry = this.drivers.get(id);
    if (!entry) return false;
    entry.intentionalStop = true;
    for (const msg of entry.queue.splice(0)) {
      this.pushAck(id, msg.commandId, false, "已退出接管模式，指令取消");
    }
    for (const req of [...entry.hostRequests.values()]) {
      this.finishHostRequest(entry, req, { behavior: "deny", message: "已退出接管模式" }, "cancelled");
    }
    this.killChild(entry.child);
    this.clearIdle(entry);
    this.stopMirrorFn(id);
    this.drivers.delete(id);
    this.emit(id, { type: "attach_state", attached: false, terminalOnline: false });
    return true;
  }

  isAttached(id: string): boolean {
    const entry = this.drivers.get(id);
    return entry !== undefined && !entry.child.killed;
  }

  statusFor(id: string): TerminalAttachInfo {
    // hub 形态：online = 可接管（hub 随时能拉起 driver）；attached = 驱动进程存活
    return this.isAttached(id)
      ? { online: true, attached: true, driver: "hub", mirror: this.drivers.get(id)?.mirror ?? false }
      : { online: true, attached: false, driver: "hub", mirror: false };
  }

  // ---- 消息注入（真用户 turn）----

  send(id: string, input: { text: unknown; mode?: unknown; clientMessageId?: unknown }): DriverCommand {
    this.ensureAlive();
    const entry = this.drivers.get(id);
    if (!entry || entry.child.killed) {
      throw new HubError(ErrorCodes.ATTACH_REQUIRED, "该会话未处于接管模式（驱动进程未运行）", 409);
    }
    if (typeof input.text !== "string" || input.text.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    const mode = parseDriverMode(input.mode);
    // clientMessageId 幂等（对齐 agents.ts：全局 clientSeen + 会话 byClient 双层）
    const clientMessageId =
      typeof input.clientMessageId === "string" && input.clientMessageId !== ""
        ? input.clientMessageId.slice(0, 128)
        : null;
    if (clientMessageId !== null) {
      const seen = this.clientSeen.get(clientMessageId);
      if (seen && Date.now() - seen.at < CLIENT_IDEMPOTENT_TTL_MS) {
        return { id: seen.commandId, mode };
      }
      const byClient = entry.byClient.get(clientMessageId);
      if (byClient !== undefined) {
        return { id: byClient, mode };
      }
    }

    const commandId = `cmd-${randomBytes(8).toString("hex")}`;
    if (clientMessageId !== null) {
      entry.byClient.set(clientMessageId, commandId);
      this.clientSeen.set(clientMessageId, { commandId, at: Date.now() });
    }

    // 语义映射（E3/E3b 实测，预案 B）：
    // - prompt：空闲直写；忙时失败回执（与 pi-command planInjection 同语义，不打扰运行中 turn）
    // - steer：立即写 stdin = 工具间隙转向（真插话）
    // - followUp：本地排队到 result 后写入
    if (mode === "prompt" && entry.turnActive) {
      this.pushAck(id, commandId, false, "会话正忙：prompt 模式仅空闲时可发，请用「插话」或「排队」");
      return { id: commandId, mode };
    }
    if (mode === "followUp" && entry.turnActive) {
      entry.queue.push({ commandId, text: input.text, mode });
      return { id: commandId, mode };
    }
    this.writeMessage(entry, commandId, input.text);
    return { id: commandId, mode };
  }

  /** abort：control interrupt（E4：turn 收尾、进程存活）；清空未投递队列 */
  abortTurn(id: string): void {
    const entry = this.drivers.get(id);
    if (!entry || entry.child.killed) return;
    for (const msg of entry.queue.splice(0)) {
      this.pushAck(id, msg.commandId, false, "已中止当前运行，排队指令取消");
    }
    if (entry.turnActive) {
      this.writeStdin(entry, encodeInterrupt(`req-${randomUUID().slice(0, 8)}`));
    }
  }

  // ---- 权限请求（bridge 机器通道 + 手机应答）----

  /**
   * bridge 注册权限请求并挂起等待人工应答（HTTP 长挂起）。
   * 超时一律 deny（安全默认，绝不自动 allow）；detach/崩溃收尾同样 deny。
   */
  registerHostRequest(body: BridgeHostRequestBody, now = Date.now()): Promise<HostRequestDecision> {
    const entry = this.drivers.get(body.sessionId);
    if (!entry || entry.child.killed) {
      return Promise.resolve({ behavior: "deny", message: "session not attached" });
    }
    // 幂等：同一 requestId 重复上报（bridge 重试）复用同一挂起
    const existing = entry.hostRequests.get(body.requestId);
    if (existing) {
      return new Promise((resolve) => {
        const prev = existing.resolve;
        existing.resolve = (d) => {
          prev(d);
          resolve(d);
        };
      });
    }
    return new Promise((resolve) => {
      const req: HostRequestEntry = {
        sessionId: body.sessionId,
        requestId: body.requestId,
        toolName: body.toolName,
        title: hostRequestTitle(body.toolName, body.input),
        detail: body.description ?? previewInput(body.input),
        input: body.input,
        createdAt: now,
        expiresAt: now + this.hostRequestTtlMs,
        resolve,
        timer: setTimeout(() => {
          const cur = entry.hostRequests.get(body.requestId);
          if (cur) this.finishHostRequest(entry, cur, { behavior: "deny", message: "approval timed out" }, "timeout");
        }, this.hostRequestTtlMs),
      };
      req.timer.unref?.();
      entry.hostRequests.set(body.requestId, req);
      this.touchIdle(entry);
      this.emit(body.sessionId, {
        type: "host_request",
        request: {
          id: req.requestId,
          sessionId: req.sessionId,
          kind: "permission",
          title: req.title,
          detail: req.detail,
          toolName: req.toolName,
          allowAlways: false,
          createdAt: req.createdAt,
          expiresAt: req.expiresAt,
        },
      });
    });
  }

  listHostRequests(id: string): HostRequestDto[] {
    const entry = this.drivers.get(id);
    if (!entry) return [];
    return [...entry.hostRequests.values()].map((r) => ({
      id: r.requestId,
      sessionId: r.sessionId,
      kind: "permission" as const,
      title: r.title,
      detail: r.detail,
      toolName: r.toolName,
      allowAlways: false,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** 手机应答；未知 id 返回 false（路由转 404），已决同样 false（幂等回放由路由层处理） */
  respondHostRequest(id: string, requestId: string, decision: HostRequestDecision): boolean {
    const entry = this.drivers.get(id);
    if (!entry) return false;
    const req = entry.hostRequests.get(requestId);
    if (!req) return false;
    this.finishHostRequest(entry, req, decision, decision.behavior === "allow" ? "allow" : "deny");
    return true;
  }

  // ---- 清扫/关闭 ----

  startSweep(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref?.();
  }

  sweep(now = Date.now()): void {
    // 空闲自动 detach 由 touchIdle 计时器自管（turn 中顺延）；sweep 只做幂等缓存清理
    for (const [key, seen] of this.clientSeen) {
      if (now - seen.at > CLIENT_IDEMPOTENT_TTL_MS) this.clientSeen.delete(key);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const id of [...this.drivers.keys()]) {
      this.detach(id);
    }
    this.clientSeen.clear();
  }

  // ---- 内部 ----

  private ensureAlive(): void {
    if (this.disposed) {
      throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503);
    }
  }

  private bindChild(entry: DriverEntry): void {
    let stdoutRest = "";
    entry.child.stdout?.on("data", (chunk: Buffer | string) => {
      this.touchIdle(entry);
      stdoutRest += String(chunk);
      let idx = stdoutRest.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutRest.slice(0, idx);
        stdoutRest = stdoutRest.slice(idx + 1);
        idx = stdoutRest.indexOf("\n");
        if (line.trim() === "") continue;
        this.handleStdoutLine(entry, line);
      }
    });
    entry.child.stderr?.on("data", (chunk: Buffer | string) => {
      entry.stderrTail = (entry.stderrTail + String(chunk)).slice(-STDERR_PREVIEW_LIMIT);
    });
    entry.child.on("error", () => {
      // spawn 失败（claude 不存在等）：清理 + 广播
      this.handleCrash(entry);
    });
    entry.child.on("close", () => {
      if (entry.intentionalStop) return;
      this.handleCrash(entry);
    });
  }

  private handleStdoutLine(entry: DriverEntry, line: string): void {
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // result = turn 结束（E3）：消费 followUp 队列
    if (row.type === "result") {
      entry.turnActive = false;
      const next = entry.queue.shift();
      if (next) {
        this.writeMessage(entry, next.commandId, next.text);
      }
      return;
    }
    // control_response（interrupt 回执）不进消息翻译
    if (row.type === "control_response" || row.type === "control_request") return;
    try {
      for (const event of entry.translator.feed(line)) {
        this.emit(entry.sessionId, event);
      }
    } catch {
      // 翻译异常静默（单行损坏不拖垮驱动）
    }
    if (row.type === "user" || row.type === "assistant") {
      // 消息级活动：turn 一定在进行中
      entry.turnActive = true;
    }
  }

  private writeMessage(entry: DriverEntry, commandId: string, text: string): void {
    const ok = this.writeStdin(entry, encodeUserMessage(text));
    if (ok) {
      entry.turnActive = true;
      this.touchIdle(entry);
      // 合成 user 气泡（-p 不回显 prompt；前端去重层合并乐观占位，对齐 ClaudeAdapter.emitUserMessage）
      this.emit(entry.sessionId, {
        type: "message_end",
        message: {
          id: `live-user-${commandId}`,
          role: "user",
          timestamp: Date.now(),
          text,
          toolCalls: [],
        },
      });
    }
    this.pushAck(entry.sessionId, commandId, ok, ok ? null : "注入失败：驱动进程输入已关闭");
  }

  private writeStdin(entry: DriverEntry, line: string): boolean {
    try {
      if (!entry.child.stdin || entry.child.stdin.destroyed) return false;
      entry.child.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private pushAck(sessionId: string, commandId: string, ok: boolean, error: string | null): void {
    this.emit(sessionId, { type: "command_ack", commandId, ok, error });
  }

  private handleCrash(entry: DriverEntry): void {
    if (entry.intentionalStop) return;
    entry.intentionalStop = true;
    for (const msg of entry.queue.splice(0)) {
      this.pushAck(entry.sessionId, msg.commandId, false, "接管进程已退出，指令取消");
    }
    for (const req of [...entry.hostRequests.values()]) {
      this.finishHostRequest(entry, req, { behavior: "deny", message: "driver exited" }, "cancelled");
    }
    const preview = entry.stderrTail.trim();
    if (preview !== "") {
      this.emit(entry.sessionId, {
        type: "error",
        code: ErrorCodes.DRIVER_FAILED,
        message: `接管进程已退出：${preview.slice(-STDERR_PREVIEW_LIMIT)}`,
      });
    }
    this.clearIdle(entry);
    this.stopMirrorFn(entry.sessionId);
    this.drivers.delete(entry.sessionId);
    this.emit(entry.sessionId, { type: "attach_state", attached: false, terminalOnline: false });
  }

  private finishHostRequest(
    entry: DriverEntry,
    req: HostRequestEntry,
    decision: HostRequestDecision,
    outcome: "allow" | "deny" | "timeout" | "cancelled",
  ): void {
    clearTimeout(req.timer);
    entry.hostRequests.delete(req.requestId);
    this.emit(req.sessionId, { type: "host_request_resolved", requestId: req.requestId, outcome });
    req.resolve(decision);
    this.touchIdle(entry);
  }

  private killChild(child: ChildProcess): void {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 忽略 */
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  private touchIdle(entry: DriverEntry): void {
    this.clearIdle(entry);
    if (this.idleDetachMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      // 到点再查一次活跃状态（turn 中/有挂起请求则顺延）
      if (entry.turnActive || entry.hostRequests.size > 0) {
        this.touchIdle(entry);
        return;
      }
      this.detach(entry.sessionId);
    }, this.idleDetachMs);
    entry.idleTimer.unref?.();
  }

  private clearIdle(entry: DriverEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}

function isBypass(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const perms = (settings as Record<string, unknown>).permissions;
  if (typeof perms !== "object" || perms === null) return false;
  return (perms as Record<string, unknown>).defaultMode === "bypassPermissions";
}

function previewInput(input: unknown): string | null {
  try {
    const s = JSON.stringify(input);
    return s.length > 300 ? `${s.slice(0, 297)}...` : s;
  } catch {
    return null;
  }
}

/** 默认 settings 探测：用户级 + 项目级（与 CLI 同向：项目本地更具体的覆盖） */
async function defaultReadSettings(sessionCwd: string): Promise<unknown> {
  const candidates = [
    join(homedir(), ".claude", "settings.json"),
    join(sessionCwd, ".claude", "settings.json"),
    join(sessionCwd, ".claude", "settings.local.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw);
    } catch {
      /* 逐个回退 */
    }
  }
  return null;
}
