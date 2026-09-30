/**
 * pi-command：pi 扩展——接收 agent-hub 下发的反向指令（E3 双模式会话驱动）。
 * 手机/HTTP 发来的消息经 server 指令队列 → 本扩展长轮询取走 → pi 扩展 API 注入
 * （pi.sendUserMessage），终端 TUI 实时显示并执行。
 *
 * 架构：session_start 起两条出站通道（均连 127.0.0.1:7700，不出网、不开监听端口）：
 *   1. 心跳 POST /api/agents/heartbeat（30s 一续，server 据此判定"终端 pi 在线"，90s 无心跳离线）
 *   2. 指令长轮询 GET /api/agents/commands?sessionId=&wait=25000（挂起至有指令/超时，低延迟）
 *   执行结果回执 POST /api/agents/ack（成功/失败原因，commandId 幂等防重复注入）。
 *
 * 消息注入语义（pi SDK extensions/types.d.ts 的 sendUserMessage / agent-session 实测）：
 *   - prompt   → 空闲时直接发；正忙时 pi 会拒绝（"Agent is already processing..."），
 *                扩展在注入前用 ctx.isIdle() 预检，正忙直接回执失败原因，不打扰 pi
 *   - steer    → deliverAs:"steer"，插话当前 run（当前 assistant turn + 工具执行完即转向）
 *   - followUp → deliverAs:"followUp"，排队到当前 run 待办结束后发（空闲时等价立即发）
 *   expandPromptTemplates:true 与终端手打一致（/ 扩展命令可派发、skill/模板可展开）。
 *
 * 硬性要求（与 live-feed 同铁律）：
 * - 扩展故障静默不阻塞 pi：任何异常吞掉、定时器 unref、fetch 带超时
 * - 长轮询命令按 commandId 幂等：重投/重复下发只注入一次（结果缓存后重复直接补回执）
 * - 环境变量 AGENT_HUB_LIVE_URL 覆盖 server 地址（默认 http://127.0.0.1:7700）
 * - 环境变量 AGENT_HUB_LIVE_TOKEN 非空时带 Authorization: Bearer（与 server auth.token 对齐）
 * - session_shutdown 幂等清理；不在 factory 里起任何定时器/网络（pi 生命周期规则）
 *
 * 安装（单文件自包含，直接拷贝即可）：
 *   cp integrations/pi-command/command.ts ~/.pi/agent/extensions/pi-command.ts
 *
 * 本文件同时导出纯函数（指令→注入调用映射、URL/body 构造），供单测直接引用；
 * 运行期零第三方依赖。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_LIVE_URL = "http://127.0.0.1:7700";
/** 心跳间隔（毫秒）：server 端 90s 无心跳判定离线 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 长轮询挂起时长（毫秒）：server 端上限 30s */
export const POLL_WAIT_MS = 25_000;
/** 单次 fetch 超时（毫秒）：必须大于长轮询挂起时长 */
export const FETCH_TIMEOUT_MS = 35_000;
/** 故障退避（毫秒）：网络/server 异常时低频重试，绝不刷屏 */
export const RETRY_DELAY_MS = 5_000;
/** 鉴权失败退避（毫秒）：配置错误，长退避 */
export const AUTH_RETRY_DELAY_MS = 30_000;

// ---- 指令契约（server GET /api/agents/commands 响应项） ----

export interface AgentCommandLike {
  id?: unknown;
  kind?: unknown;
  text?: unknown;
  mode?: unknown;
}

export type InjectMode = "prompt" | "steer" | "followUp";

export interface InjectOptions {
  deliverAs?: "steer" | "followUp";
  expandPromptTemplates?: boolean;
}

export interface InjectionCall {
  content: string;
  options: InjectOptions;
}

export type InjectionPlan =
  | { ok: true; mode: InjectMode; call: InjectionCall }
  | { ok: false; error: string };

// ---- 小工具 ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** server 地址：AGENT_HUB_LIVE_URL 覆盖；尾部斜杠归一 */
export function resolveBaseUrl(baseUrl: string | undefined): string {
  const base = (baseUrl && baseUrl.trim() !== "" ? baseUrl.trim() : DEFAULT_LIVE_URL).replace(/\/+$/, "");
  return base;
}

export function heartbeatUrl(base: string | undefined): string {
  return `${resolveBaseUrl(base)}/api/agents/heartbeat`;
}

export function ackUrl(base: string | undefined): string {
  return `${resolveBaseUrl(base)}/api/agents/ack`;
}

export function commandsUrl(base: string | undefined, sessionId: string, waitMs = POLL_WAIT_MS): string {
  const query = new URLSearchParams({ sessionId, wait: String(Math.max(0, Math.floor(waitMs))) });
  return `${resolveBaseUrl(base)}/api/agents/commands?${query.toString()}`;
}

export function heartbeatBody(sessionId: string, cwd: string): Record<string, unknown> {
  return {
    sessionId,
    pid: typeof process !== "undefined" ? process.pid : null,
    cwd,
    capabilities: ["message", "steer", "followUp"],
  };
}

export function ackBody(
  sessionId: string,
  commandId: string,
  ok: boolean,
  error?: string,
): Record<string, unknown> {
  return { sessionId, commandId, ok, error: error === undefined ? undefined : error.slice(0, 500) };
}

/**
 * 指令 → pi 注入调用映射（核心语义，纯函数）。
 * prompt 模式仅空闲时发（isIdle=false 直接给失败原因，不打扰正在跑的 run）。
 */
export function planInjection(cmd: AgentCommandLike, isIdle: () => boolean): InjectionPlan {
  if (cmd.kind !== "message") {
    return { ok: false, error: `未知指令类型: ${String(cmd.kind)}` };
  }
  const text = typeof cmd.text === "string" ? cmd.text.trim() : "";
  if (text === "") {
    return { ok: false, error: "指令缺少 text" };
  }
  const rawMode = typeof cmd.mode === "string" && cmd.mode !== "" ? cmd.mode : "prompt";
  if (rawMode === "steer") {
    return {
      ok: true,
      mode: "steer",
      call: { content: text, options: { deliverAs: "steer", expandPromptTemplates: true } },
    };
  }
  if (rawMode === "followUp") {
    return {
      ok: true,
      mode: "followUp",
      call: { content: text, options: { deliverAs: "followUp", expandPromptTemplates: true } },
    };
  }
  if (rawMode === "prompt") {
    let idle = false;
    try {
      idle = isIdle();
    } catch {
      idle = false;
    }
    if (!idle) {
      return { ok: false, error: "终端正忙：prompt 模式仅空闲时可发，请改用插话(steer)/排队(followUp)" };
    }
    return { ok: true, mode: "prompt", call: { content: text, options: { expandPromptTemplates: true } } };
  }
  return { ok: false, error: `未知指令 mode: ${rawMode}` };
}

/** 指令执行结果（回执内容） */
export interface ExecOutcome {
  commandId: string;
  ok: boolean;
  error: string | null;
}

export interface ExecDeps {
  sendUserMessage(content: string, options: InjectOptions): void;
  isIdle(): boolean;
}

/** 执行单条指令（注入 + 结果判定）；任何异常转为失败回执，绝不抛出 */
export function executeCommand(cmd: AgentCommandLike, deps: ExecDeps): ExecOutcome {
  const commandId = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : "";
  if (commandId === "") {
    return { commandId: "", ok: false, error: "指令缺少 id" };
  }
  const plan = planInjection(cmd, deps.isIdle);
  if (!plan.ok) {
    return { commandId, ok: false, error: plan.error };
  }
  try {
    deps.sendUserMessage(plan.call.content, plan.call.options);
    return { commandId, ok: true, error: null };
  } catch (err) {
    return { commandId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- 扩展入口（心跳 + 长轮询 + 注入 + 回执；全部 fire-and-forget 静默） ----

function postJson(url: string, token: string | undefined, body: unknown): void {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const request = fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    void Promise.resolve(request).catch(() => undefined);
  } catch {
    // 静默：扩展故障不影响 pi
  }
}

export default function piCommand(pi: ExtensionAPI): void {
  let running = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sessionId = "";
  let cwd = "";
  let token: string | undefined;
  let base: string | undefined;
  /** 已执行指令结果缓存（重投幂等：重复下发不重复注入，只补回执） */
  const executed = new Map<string, ExecOutcome>();
  /** 捕获的上下文动作（session_start 时快照；异常一律降级） */
  let isIdleFn: (() => boolean) | null = null;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // 静默
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  const sendAck = (outcome: ExecOutcome): void => {
    if (outcome.commandId === "") return;
    postJson(ackUrl(base ?? ""), token, ackBody(sessionId, outcome.commandId, outcome.ok, outcome.error ?? undefined));
  };

  const handleCommand = (raw: unknown): void => {
    if (!isRecord(raw)) return;
    const cmd: AgentCommandLike = raw;
    const commandId = typeof cmd.id === "string" ? cmd.id : "";
    const cached = commandId !== "" ? executed.get(commandId) : undefined;
    if (cached) {
      // 重复投递：不重复注入，只补回执（幂等）
      sendAck(cached);
      return;
    }
    const outcome = executeCommand(cmd, {
      sendUserMessage: (content, options) => {
        pi.sendUserMessage(content, options);
      },
      isIdle: () => (isIdleFn ? isIdleFn() : true),
    });
    if (commandId !== "") {
      executed.set(commandId, outcome);
      // 有界保留最近 200 条
      if (executed.size > 200) {
        const oldest = executed.keys().next();
        if (!oldest.done) executed.delete(oldest.value);
      }
    }
    sendAck(outcome);
  };

  const fetchCommands = async (): Promise<AgentCommandLike[] | null> => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
      const res = await fetch(commandsUrl(base ?? "", sessionId, POLL_WAIT_MS), { headers, signal });
      if (res.status === 401 || res.status === 403) {
        await sleep(AUTH_RETRY_DELAY_MS);
        return [];
      }
      if (!res.ok) {
        await sleep(RETRY_DELAY_MS);
        return [];
      }
      const body = (await res.json()) as { commands?: unknown };
      const list = Array.isArray(body.commands) ? body.commands : [];
      return list.filter(isRecord) as AgentCommandLike[];
    } catch {
      await sleep(RETRY_DELAY_MS);
      return [];
    }
  };

  const pollLoop = async (): Promise<void> => {
    while (running) {
      const commands = await fetchCommands();
      if (!running) return;
      for (const cmd of commands ?? []) {
        safe(() => handleCommand(cmd));
      }
    }
  };

  const start = (ctx: ExtensionContext): void => {
    if (running) return;
    running = true;
    safe(() => {
      sessionId = ctx.sessionManager.getSessionId();
    });
    safe(() => {
      cwd = ctx.cwd;
    });
    isIdleFn = (): boolean => {
      try {
        return ctx.isIdle();
      } catch {
        return true;
      }
    };
    token = process.env.AGENT_HUB_LIVE_TOKEN;
    base = process.env.AGENT_HUB_LIVE_URL;

    const beat = (): void => safe(() => postJson(heartbeatUrl(base ?? ""), token, heartbeatBody(sessionId, cwd)));
    beat();
    heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    void pollLoop();
  };

  const stop = (): void => {
    // 幂等：reload / 退出 / session_shutdown 可能重复触发
    running = false;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    isIdleFn = null;
  };

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    start(ctx);
  });

  pi.on("session_shutdown", () => {
    stop();
  });
}
