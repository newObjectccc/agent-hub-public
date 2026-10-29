/**
 * HostRequestRegistry：claude 权限请求（手机批权限）的挂起/应答登记表（契约 §12）。
 *
 * 从 ClaudeDriverHub 解耦：attach（🖥 接管）与 parallel（📱 平行 spawn-per-message）两条执行
 * 路径共用同一审批通道——bridge POST /api/agents/host-requests 注册挂起、手机 HostRequestCard
 * 应答解结，手机端只有一套 UI。数据与生命周期归本类；「会话是否有人在环」的守卫由调用方
 * 判定（ClaudeDriverHub.registerHostRequest：attach 中或 parallel run 中才挂起，
 * 未知会话的伪造请求一律 deny）。
 *
 * 硬性安全默认（与 bridge.mjs 同铁律）：
 * - 超时/会话收尾（detach、run 结束、崩溃、dispose）一律 deny，绝不自动 allow；
 * - 已决记忆（requestId → TTL）：双重应答/移动端幂等回放判 409 HOST_REQUEST_RESOLVED 而非误报 404。
 */
import type { HostRequestDto, ServerEvent } from "../types.js";
import { hostRequestTitle, type BridgeHostRequestBody, type PermissionBehavior } from "./claude-host-protocol.js";

export interface HostRequestDecision {
  behavior: PermissionBehavior;
  message: string;
}

export type HostRequestOutcome = "allow" | "deny" | "timeout" | "cancelled";

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

export interface HostRequestRegistryOptions {
  emit: (sessionId: string, event: ServerEvent) => void;
  /** 权限请求人工应答超时（超时一律 deny，绝不自动 allow） */
  hostRequestTtlMs?: number;
  /** 已决记忆 TTL */
  resolvedTtlMs?: number;
  /** 已决记忆上限（防膨胀：超限淘汰最旧） */
  maxResolved?: number;
}

const DEFAULT_HOST_REQUEST_TTL_MS = 5 * 60_000;
const DEFAULT_RESOLVED_TTL_MS = 5 * 60_000;
const MAX_RESOLVED_HOST_REQUESTS = 200;

export class HostRequestRegistry {
  private readonly emit: (sessionId: string, event: ServerEvent) => void;
  private readonly hostRequestTtlMs: number;
  private readonly resolvedTtlMs: number;
  private readonly maxResolved: number;
  /** sessionId → 未决请求 */
  private readonly pending = new Map<string, Map<string, HostRequestEntry>>();
  /** 已决记忆（requestId → 过期时间） */
  private readonly resolved = new Map<string, number>();
  /** 挂起请求决出（allow/deny/timeout/cancelled）时通知（driver 据此 touchIdle 等） */
  private readonly settledListeners = new Set<(sessionId: string) => void>();

  constructor(options: HostRequestRegistryOptions) {
    this.emit = options.emit;
    this.hostRequestTtlMs = options.hostRequestTtlMs ?? DEFAULT_HOST_REQUEST_TTL_MS;
    this.resolvedTtlMs = options.resolvedTtlMs ?? DEFAULT_RESOLVED_TTL_MS;
    this.maxResolved = options.maxResolved ?? MAX_RESOLVED_HOST_REQUESTS;
  }

  addSettledListener(fn: (sessionId: string) => void): void {
    this.settledListeners.add(fn);
  }

  removeSettledListener(fn: (sessionId: string) => void): void {
    this.settledListeners.delete(fn);
  }

  /**
   * 注册权限请求并挂起等待人工应答（HTTP 长挂起）。
   * 幂等：同一 requestId 重复上报（bridge 重试）复用同一挂起。
   */
  register(body: BridgeHostRequestBody, now = Date.now()): Promise<HostRequestDecision> {
    const sessionRequests = this.pending.get(body.sessionId) ?? new Map<string, HostRequestEntry>();
    this.pending.set(body.sessionId, sessionRequests);
    const existing = sessionRequests.get(body.requestId);
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
          const cur = sessionRequests.get(body.requestId);
          if (cur) this.finish(cur, { behavior: "deny", message: "approval timed out" }, "timeout");
        }, this.hostRequestTtlMs),
      };
      req.timer.unref?.();
      sessionRequests.set(body.requestId, req);
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

  list(sessionId: string): HostRequestDto[] {
    const sessionRequests = this.pending.get(sessionId);
    if (!sessionRequests) return [];
    return [...sessionRequests.values()].map((r) => ({
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

  /** 手机应答；未知 id 返回 false（路由转 404），已决同样 false（路由凭 isResolved 转 409） */
  respond(sessionId: string, requestId: string, decision: HostRequestDecision): boolean {
    const req = this.pending.get(sessionId)?.get(requestId);
    if (!req) return false;
    this.finish(req, decision, decision.behavior === "allow" ? "allow" : "deny");
    return true;
  }

  /**
   * 已决 id 记忆（契约 §12：已决 → 409 HOST_REQUEST_RESOLVED）：
   * finish 记入短期记忆（默认 TTL 5 分钟、上限 200 条防膨胀），过期/超限淘汰后回 false（路由转 404）。
   */
  isResolved(requestId: string, now = Date.now()): boolean {
    const expiresAt = this.resolved.get(requestId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.resolved.delete(requestId);
      return false;
    }
    return true;
  }

  hasPending(sessionId: string): boolean {
    return (this.pending.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * 会话收尾（detach / parallel run 结束 / 崩溃 / dispose）：挂起请求一律 deny 收尾。
   * bridge 的 HTTP 长挂起据此立即返回，不等 TTL；前端卡片同步消失。
   */
  cancelSession(sessionId: string, message: string, outcome: HostRequestOutcome = "cancelled"): void {
    const sessionRequests = this.pending.get(sessionId);
    if (!sessionRequests) return;
    for (const req of [...sessionRequests.values()]) {
      this.finish(req, { behavior: "deny", message }, outcome);
    }
  }

  /** 清理过期的已决记忆（幂等；driver/adapter 的 sweep 顺带调用） */
  sweep(now = Date.now()): void {
    for (const [id, expiresAt] of this.resolved) {
      if (expiresAt <= now) this.resolved.delete(id);
    }
  }

  private finish(req: HostRequestEntry, decision: HostRequestDecision, outcome: HostRequestOutcome): void {
    clearTimeout(req.timer);
    this.pending.get(req.sessionId)?.delete(req.requestId);
    if (this.pending.get(req.sessionId)?.size === 0) this.pending.delete(req.sessionId);
    // 已决记忆（契约 §12）：从 pending 删除后仍可判 409，双重应答不再误报 404
    this.rememberResolved(req.requestId);
    this.emit(req.sessionId, { type: "host_request_resolved", requestId: req.requestId, outcome });
    req.resolve(decision);
    for (const fn of this.settledListeners) {
      try {
        fn(req.sessionId);
      } catch {
        /* 监听器异常静默隔离，绝不拖垮决出流程 */
      }
    }
  }

  /** 记入已决记忆：TTL 默认 5 分钟；超限淘汰最旧（Map 插入序），顺带清过期条目防膨胀 */
  private rememberResolved(requestId: string, now = Date.now()): void {
    this.resolved.delete(requestId);
    this.resolved.set(requestId, now + this.resolvedTtlMs);
    for (const [id, expiresAt] of this.resolved) {
      if (expiresAt <= now) this.resolved.delete(id);
    }
    while (this.resolved.size > this.maxResolved) {
      const oldest = this.resolved.keys().next().value;
      if (oldest === undefined) break;
      this.resolved.delete(oldest);
    }
  }
}

function previewInput(input: unknown): string | null {
  try {
    const s = JSON.stringify(input);
    return s.length > 300 ? `${s.slice(0, 297)}...` : s;
  } catch {
    return null;
  }
}
