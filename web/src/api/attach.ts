/**
 * 双模式会话驱动（E3）纯逻辑：模式持久化、发送模式→attach 指令模式映射、
 * 会话列表徽章文案、接管可用性判定、发送回执状态条文案。
 *
 * 模式语义（与 server 契约 §12 一致）：
 * - parallel（📱 平行继续）：消息走 server SDK（现状），终端 pi 不受影响
 * - attach（🖥 接管终端）：消息入指令队列，电脑终端 pi 进程实时显示并执行
 */
import { codexPolicySummary } from "./codexPolicy";
import type { EffectivePolicyDto, AttachCommandMode, TerminalAttachInfo } from "./types";
import type { SendMode } from "./prompt";

export type AttachMode = "parallel" | "attach";

/** 首次双模式说明 sheet 只展示一次（全局） */
export const ATTACH_INTRO_KEY = "agent-hub.attachIntro.v1";
const ATTACH_MODE_PREFIX = "agent-hub.attachMode.v1:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function attachModeKey(sessionId: string): string {
  return `${ATTACH_MODE_PREFIX}${sessionId}`;
}

/** 读取会话的模式选择（缺省 parallel；存储不可用/损坏一律回落 parallel） */
export function loadAttachMode(storage: StorageLike | null, sessionId: string): AttachMode {
  try {
    return storage?.getItem(attachModeKey(sessionId)) === "attach" ? "attach" : "parallel";
  } catch {
    return "parallel";
  }
}

export function saveAttachMode(storage: StorageLike | null, sessionId: string, mode: AttachMode): void {
  try {
    storage?.setItem(attachModeKey(sessionId), mode);
  } catch {
    // 存储不可用：仅本次会话内生效
  }
}

/**
 * 用户"手动选择"记录（modePinned 语义）：与 attachModeKey 分开——
 * attachModeKey 存的是"当前生效模式"（自动默认/跨设备校正也会写），
 * 本 key 只由用户手动切换（changeAttachMode / 说明 sheet 选择）写入，存用户选中的模式。
 * 有记录 = 用户手动选过 → 打开会话时不再被智能默认/校正自动改写（用户选择永远最高优先）。
 */
const ATTACH_MODE_PINNED_PREFIX = "agent-hub.attachModePinned.v1:";

export function attachModePinnedKey(sessionId: string): string {
  return `${ATTACH_MODE_PINNED_PREFIX}${sessionId}`;
}

/** 读取用户手动选择的模式（无记录/损坏 → null = 从未手动选过，允许智能默认） */
export function loadPinnedAttachMode(storage: StorageLike | null, sessionId: string): AttachMode | null {
  try {
    const raw = storage?.getItem(attachModePinnedKey(sessionId));
    return raw === "attach" || raw === "parallel" ? raw : null;
  } catch {
    return null;
  }
}

/** 记录用户手动选择（仅用户显式切换调用；智能默认/自动校正绝不写入） */
export function pinAttachMode(storage: StorageLike | null, sessionId: string, mode: AttachMode): void {
  try {
    storage?.setItem(attachModePinnedKey(sessionId), mode);
  } catch {
    // 存储不可用：仅本次会话内优先
  }
}

export function loadIntroSeen(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(ATTACH_INTRO_KEY) === "1";
  } catch {
    return true; // 存储不可用时不再打扰
  }
}

export function markIntroSeen(storage: StorageLike | null): void {
  try {
    storage?.setItem(ATTACH_INTRO_KEY, "1");
  } catch {
    // 忽略
  }
}

/**
 * composer 发送模式 → attach 指令模式：
 * - auto → followUp（空闲立即发、正忙排队，与 parallel auto 的 409→followUp 降级同语义）
 * - prompt/steer/followUp 原样透传（prompt 严格"空闲才发"，正忙回执失败原因）
 */
export function mapAttachSendMode(mode: SendMode): AttachCommandMode {
  if (mode === "auto") return "followUp";
  return mode;
}

/** 会话列表徽章（🖥⚡ 已接管 / 🖥 终端在线|可接管 / 📱 平行线）；无终端状态不显示 */
export interface AttachBadgeInfo {
  icon: string;
  label: string;
  title: string;
  variant: "attached" | "online" | "parallel";
}

/**
 * 徽章渲染（D2）：
 * - attached → 🖥⚡ 已接管（文案按 driver 分支）
 * - hub 形态未接管：仅活跃会话显示 🖥 可接管（历史空闲不显示，避免列表噪音）
 * - queue（pi）形态：online → 🖥 终端在线；否则 📱 平行线
 */
export function attachBadge(
  terminal: TerminalAttachInfo | null | undefined,
  status?: "idle" | "running" | "error",
): AttachBadgeInfo | null {
  if (!terminal) return null;
  const hub = terminal.driver === "hub";
  const codex = terminal.source === "codex";
  if (terminal.attached) {
    return {
      icon: "🖥⚡",
      label: "已接管",
      title: codex ? `🖥⚡ 已接管：${codexPolicySummary(terminal.effectivePolicy)}；退出接管后可在电脑继续` : hub
        ? "🖥⚡ 已接管：消息由 hub 驱动 claude 执行并写回同一会话（电脑终端投屏实时显示）"
        : "🖥⚡ 已接管：消息发往电脑终端 pi 进程执行",
      variant: "attached",
    };
  }
  if (hub) {
    if (status !== "running") return null; // 历史空闲 claude 会话不显示徽章
    return {
      icon: "🖥",
      label: "可接管",
      title: codex ? "🖥 可接管：切换后由 Codex 驱动继续；若电脑正在占用会话，会提示退出后重试" : "🖥 可接管：切换接管模式后消息由 hub 直接驱动 claude 执行",
      variant: "online",
    };
  }
  if (terminal.online) {
    return {
      icon: "🖥",
      label: "终端在线",
      title: "🖥 终端在线：可切换为接管模式（消息发往终端 pi）",
      variant: "online",
    };
  }
  return {
    icon: "📱",
    label: "平行线",
    title: "📱 平行线：消息由 server 的 pi 实例继续处理",
    variant: "parallel",
  };
}

/** 接管可用性：pi 需终端在线；hub 形态（Claude / Codex）可尝试启动驱动。 */
export interface AttachAvailability {
  attachEnabled: boolean;
  attachDisabledReason: string | null;
}

export function attachAvailability(
  terminal: TerminalAttachInfo | null | undefined,
  source?: string,
): AttachAvailability {
  if (terminal?.driver === "hub") return { attachEnabled: true, attachDisabledReason: null };
  if (terminal?.online === true) return { attachEnabled: true, attachDisabledReason: null };
  // 无终端状态：按会话来源给准确的灰显原因（避免对 codex 误报「终端 pi 不在线」）
  if (source === "codex") {
    return {
      attachEnabled: false,
      attachDisabledReason: "暂无法接管：server 未启用 Codex 接管（请检查版本、codexDriver.enabled；归档会话需先恢复）",
    };
  }
  if (source === "claude") {
    return {
      attachEnabled: false,
      // 旧 server（无 claude 接管路由）与新 server 关掉 claudeDriver.enabled 都走到这里，文案一并覆盖
      attachDisabledReason: "暂无法接管：server 未启用 claude 接管（需 v0.3+ 且 claudeDriver.enabled）",
    };
  }
  return {
    attachEnabled: false,
    attachDisabledReason: "终端 pi 不在线：电脑终端需运行带 pi-command 扩展的 pi 会话",
  };
}

/**
 * 智能默认判定（D3）：策略读 terminal.defaultPolicy（server config.claudeDriver.defaultPolicy
 * 随 terminal 下发；老 server 缺省按 "active-only" 容错，行为与历史一致）。
 * - "never"：永不默认接管（只手动切换；用户手动 pin 的更高优先在 ChatPage 侧保证，不在此层）
 * - "always"：打开即默认接管——历史空闲会话也接管（与 active-only 的区别），但仅当接管当下可行：
 *   hub 形态可尝试接管（真正启动仍受 server 静默窗/并发上限约束）；pi 要求 terminal.online===true
 * - "active-only"（含缺省）：电脑上正活跃才默认接管——
 *   pi：终端扩展在线；claude（hub）：tail/mtime 推断 running，或最后由终端驱动
 * pinned（用户手动选择）永远优先于本判定（ChatPage 侧保证）。
 * Codex 产品规则（2026-10-23 用户明确）：无论策略，codex 源默认永远 📱 平行继续——
 * 接管有「须先退出桌面 ChatGPT app 对应会话」的写者互斥前提，进入会话时默认接管几乎必失败；
 * 这与 pi/claude（active-only：电脑上活跃 → 默认接管）刻意区分。手动切换 / pin 不受限。
 * 无论何种策略，纯新建空会话（无任何消息且不在运行）都不默认接管：
 * 它是创建端自己的干净平行会话，不是电脑终端的会话（用户定调：手机 PWA 新建 ≠ 接管电脑）。
 */
export function attachDefaultWorthy(
  session: { source?: string; status?: string; lastDrivenBy?: string; messageCount?: number } | null | undefined,
  terminal: TerminalAttachInfo | null | undefined,
): boolean {
  if (!terminal) return false;
  // codex 硬规则（与 defaultPolicy 无关）：双源判定容错（老 server 只给其一）
  if (session?.source === "codex" || terminal.source === "codex") return false;
  // 纯新建空会话闸门（与策略无关的不变量）：无消息且不在运行的会话不属于任何一端，
  // 默认永不接管；旧 server 可能误标 lastDrivenBy="terminal"，此处兜底。手动切换/ pin 不受限。
  // messageCount 可缺省（老 server）按 undefined 不拦；running 例外（电脑上有活跃进程，接管有意义）。
  if (session?.messageCount === 0 && session?.status !== "running") return false;
  const policy = terminal.defaultPolicy ?? "active-only"; // 老 server 无字段 → 原有行为
  if (policy === "never") return false;
  const hub = terminal.driver === "hub";
  // 默认策略的前端门槛：hub 可尝试；实际启动检查由 server 执行。pi 还要求扩展在线。
  if (!hub && terminal.online !== true) return false;
  // pi 还要求扩展**真的在取指令**：心跳 TTL 是 90s，用户关掉终端后的这 90s 里 online 仍为 true，
  // 此时自动接管就是「假接管」——消息入了队列却没人取，用户要等一分钟才知道，文本还会丢。
  // responsive 缺省（老 server 不下发）按 true 容错，保持历史行为。
  if (!hub && terminal.responsive === false) return false;
  if (policy === "always") return true;
  // active-only：电脑上正活跃才接管（pi 在线已由上面可行性闸门保证）
  return hub ? session?.status === "running" || session?.lastDrivenBy === "terminal" : true;
}

/** 发送后状态条（一行小字确认归属；与 E1 阶段状态条同区域但独立组件/状态字） */
export interface ChannelEchoState {
  channel: "attach" | "parallel";
  /** sent=已提交；acked=终端已接收；failed=注入失败；working=平行线工作中 */
  phase: "sent" | "acked" | "failed" | "working";
  /** 失败原因 / 补充说明 */
  detail?: string | null;
  /** 关联指令 id（旧指令的迟到回执不覆盖当前状态） */
  commandId?: string;
  /** 驱动形态（hub=claude 驱动文案分支） */
  driver?: "queue" | "hub";
  source?: "claude" | "codex";
  effectivePolicy?: EffectivePolicyDto;
}

export function echoText(echo: ChannelEchoState): string {
  if (echo.channel === "attach") {
    const hub = echo.driver === "hub";
    switch (echo.phase) {
      case "sent":
        return echo.source === "codex" ? "🖥 已发往 Codex 驱动，等待接收确认…" : hub ? "🖥 已发往 claude 驱动，等待接收确认…" : "🖥 已发往终端，等待接收确认…";
      case "acked":
        return echo.source === "codex" ? `🖥 Codex 已接收 ✓ ${codexPolicySummary(echo.effectivePolicy)}` : hub ? "🖥 驱动已接收 ✓ 消息将在电脑的 claude 会话执行" : "🖥 终端已接收 ✓ 消息将在终端 pi 执行";
      case "failed":
        return `🖥 ${hub ? "注入驱动" : "终端注入"}失败${echo.detail ? `：${echo.detail}` : ""}`;
      default:
        return "🖥 接管模式";
    }
  }
  return "📱 平行线工作中…";
}

/**
 * 会话是否走 attach 发送：用户选择 attach 且 server 明确存在可接管的 terminal。
 * terminal 缺失（null/undefined：claudeDriver.enabled=false / 老 server 不下发）→ 不可接管
 * 就不走 attach 发送通道（否则 server 400「claude 会话接管未启用」卡死，detach 同样 400）；
 * terminal 存在时语义不变：server 未明确告知"未接管"（attached!==false）按接管发送，
 * Codex 选择接管后，即便驱动已退出也保持该通道，交由 server 明确拒绝并保留原文重试。
 */
export function isAttachSending(attachMode: AttachMode, terminal: TerminalAttachInfo | null | undefined, source?: string): boolean {
  if (terminal == null) return false; // 不可接管（terminal 缺失）→ 不走 attach 发送通道
  if (attachMode === "attach" && (source === "codex" || terminal.source === "codex")) return true;
  return attachMode === "attach" && terminal.attached !== false;
}
