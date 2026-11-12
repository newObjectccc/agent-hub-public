/**
 * InjectHub：「终端注入」接管注册表（docs/TERMINAL_INJECT.md）。
 *
 * 形态：接管（attach）时先做终端在场发现（terminal-host）：
 *   - TUI 在场且宿主可注入（tmux/kitty/wezterm）→ 注入接管：手机消息像打字一样进真 TUI，
 *     由 TUI 自己执行/渲染（=「就像在电脑上发送一样」），手机靠既有文件 tail 实时旁观；
 *   - TUI 在场但宿主不可注入 → 不可接管（抛 409），绝不与真人 TUI 双写（写者互斥底线）；
 *   - 无 TUI → 返回 null，路由回落 hub 后台驱动（用户规则：不在窗口就后台运行）。
 *
 * 与 ClaudeDriverHub 的关键差异：
 *   - 不持进程：TUI 本身就是执行者；detach 只清登记，TUI 原样留给电脑继续用；
 *   - 无静默窗：写者恒为 TUI 单点（手机注入和真人打字都进同一输入框、按到达先后排队，
 *     用户拍板语义），不存在双写风险；
 *   - 发送时重发现：窗口中途关闭 → 回 target-gone，路由按「不在窗口就后台」自动降级。
 */
import { randomUUID } from "node:crypto";
import { HubError, ErrorCodes } from "../errors.js";
import type { DriverCommandMode } from "./claude-driver.js";
import type { ServerEvent, TerminalAttachInfo } from "../types.js";
import { discoverHost, type AgentCmd, type HostDiscovery } from "./terminal-host.js";
import { injectMessage } from "./terminal-inject.js";

export interface InjectCommand {
  id: string;
  mode: DriverCommandMode;
}

export interface InjectAttachResult {
  attached: true;
  driver: "inject";
  mirror: false;
  /** pid↔sessionId 多候选不确定（v1 已知限制，透传给前端做预期管理） */
  ambiguous: boolean;
}

/** 发现结论三态：inject=可注入接管；no-host=有 TUI 无通道（拒绝，防双写）；none=无 TUI（可后台） */
export type AttachProbe =
  | { kind: "inject"; pid: number; host: NonNullable<HostDiscovery["host"]>; ambiguous: boolean }
  | { kind: "no-host"; pid: number }
  | { kind: "none" };

/** send 结果：gone=true → 窗口已关，调用方按「不在窗口就后台」降级 */
export type InjectSendResult = { command: InjectCommand } | { gone: true };

/** 路由/测试注入用结构接口（对齐 ClaudeDriverLinkLike 风格） */
export interface InjectHubLike {
  probe(sessionId: string, opts: { cwd: string; sessionFile: string; agent: "claude" | "codex" }): Promise<AttachProbe>;
  tryAttach(sessionId: string, opts: { cwd: string; sessionFile: string; agent: "claude" | "codex" }, probed?: Extract<AttachProbe, { kind: "inject" }>): Promise<InjectAttachResult>;
  isAttached(sessionId: string): boolean;
  send(sessionId: string, input: { text: string; mode?: DriverCommandMode; clientMessageId?: unknown }): Promise<InjectSendResult>;
  detach(sessionId: string): boolean;
  statusFor(sessionId: string): TerminalAttachInfo;
}

export interface InjectHubOptions {
  emit: (sessionId: string, event: ServerEvent) => void;
  /** 测试注入 */
  discover?: (opts: { cwd: string; sessionId: string; agent: AgentCmd }) => Promise<HostDiscovery | null>;
  inject?: (host: NonNullable<HostDiscovery["host"]>, text: string) => Promise<void>;
}

interface Entry {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  agent: Extract<AgentCmd, "claude" | "codex">;
  pid: number;
  host: NonNullable<HostDiscovery["host"]>;
  ambiguous: boolean;
}

export class InjectHub {
  private readonly entries = new Map<string, Entry>();
  private readonly emit: InjectHubOptions["emit"];
  private readonly discoverFn: NonNullable<InjectHubOptions["discover"]>;
  private readonly injectFn: NonNullable<InjectHubOptions["inject"]>;

  constructor(options: InjectHubOptions) {
    this.emit = options.emit;
    this.discoverFn = options.discover ?? ((opts) => discoverHost(opts));
    this.injectFn = options.inject ?? ((host, text) => injectMessage(host, text));
  }

  /** 探测在场结论（attach 路由此分流） */
  async probe(sessionId: string, opts: { cwd: string; sessionFile: string; agent: "claude" | "codex" }): Promise<AttachProbe> {
    const found = await this.discoverFn({ cwd: opts.cwd, sessionId, agent: opts.agent });
    if (!found) return { kind: "none" };
    if (!found.host) return { kind: "no-host", pid: found.pid };
    return { kind: "inject", pid: found.pid, host: found.host, ambiguous: found.ambiguous };
  }

  /**
   * 注入接管（probe=inject 时调用；probe 结果可传入复用，避免二次发现）。
   * 重复 attach 幂等刷新宿主。
   */
  async tryAttach(
    sessionId: string,
    opts: { cwd: string; sessionFile: string; agent: "claude" | "codex" },
    probed?: Extract<AttachProbe, { kind: "inject" }>,
  ): Promise<InjectAttachResult> {
    let pick: { pid: number; host: NonNullable<HostDiscovery["host"]>; ambiguous: boolean };
    if (probed) {
      pick = { pid: probed.pid, host: probed.host, ambiguous: probed.ambiguous };
    } else {
      const found = await this.discoverFn({ cwd: opts.cwd, sessionId, agent: opts.agent });
      if (!found) throw new HubError(ErrorCodes.ATTACH_UNAVAILABLE, "未检测到运行中的终端会话", 409);
      if (!found.host) {
        throw new HubError(
          ErrorCodes.ATTACH_UNAVAILABLE,
          "会话正在终端里运行，但该终端没有注入通道（tmux/kitty/wezterm 之外暂不支持接管注入）。请用 📱 平行模式，或先在电脑结束该会话再接管（转后台执行）",
          409,
        );
      }
      pick = { pid: found.pid, host: found.host, ambiguous: found.ambiguous };
    }
    const wasAttached = this.entries.has(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      cwd: opts.cwd,
      sessionFile: opts.sessionFile,
      agent: opts.agent,
      pid: pick.pid,
      host: pick.host,
      ambiguous: pick.ambiguous,
    });
    if (!wasAttached) this.emit(sessionId, { type: "attach_state", attached: true, terminalOnline: true });
    return { attached: true, driver: "inject", mirror: false, ambiguous: pick.ambiguous };
  }

  isAttached(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * 注入一条消息（文本 + 提交回车）= 真用户 turn。
   * 发送前重发现：窗口仍在 → 注入（宿主变化自动更新）；窗口已关 → { gone: true } 供降级。
   * 发送模式（prompt/steer/followUp）在注入形态下统一即发——排队语义由 TUI 输入框天然提供。
   */
  async send(sessionId: string, input: { text: string; mode?: DriverCommandMode; clientMessageId?: unknown }): Promise<InjectSendResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new HubError(ErrorCodes.ATTACH_UNAVAILABLE, "尚未接管终端会话", 409);
    const text = input.text ?? "";
    if (text.trim() === "") throw new HubError(ErrorCodes.INVALID_REQUEST, "消息不能为空", 400);

    const found = await this.discoverFn({ cwd: entry.cwd, sessionId, agent: entry.agent });
    if (!found) {
      this.detach(sessionId);
      return { gone: true };
    }
    if (!found.host) {
      this.detach(sessionId);
      throw new HubError(ErrorCodes.ATTACH_UNAVAILABLE, "终端已失去注入通道，请重新接管", 409);
    }
    entry.host = found.host;
    entry.pid = found.pid;
    await this.injectFn(found.host, text);
    return { command: { id: randomUUID(), mode: input.mode ?? "prompt" } };
  }

  detach(sessionId: string): boolean {
    const existed = this.entries.delete(sessionId);
    if (existed) this.emit(sessionId, { type: "attach_state", attached: false, terminalOnline: true });
    return existed;
  }

  statusFor(sessionId: string): TerminalAttachInfo {
    const entry = this.entries.get(sessionId);
    if (!entry) return { online: true, attached: false, driver: "inject" };
    return { online: true, attached: true, driver: "inject" };
  }
}
