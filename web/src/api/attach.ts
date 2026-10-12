/**
 * 双模式会话驱动（E3）纯逻辑：模式持久化、发送模式→attach 指令模式映射、
 * 会话列表徽章文案、接管可用性判定、发送回执状态条文案。
 *
 * 模式语义（与 server 契约 §12 一致）：
 * - parallel（📱 平行继续）：消息走 server SDK（现状），终端 pi 不受影响
 * - attach（🖥 接管终端）：消息入指令队列，电脑终端 pi 进程实时显示并执行
 */
import type { AttachCommandMode, TerminalAttachInfo } from "./types";
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

/** 会话列表徽章（🖥⚡ 已接管 / 🖥 终端在线 / 📱 平行线）；claude 等无终端状态不显示 */
export interface AttachBadgeInfo {
  icon: string;
  label: string;
  title: string;
  variant: "attached" | "online" | "parallel";
}

export function attachBadge(terminal: TerminalAttachInfo | null | undefined): AttachBadgeInfo | null {
  if (!terminal) return null;
  if (terminal.attached) {
    return {
      icon: "🖥⚡",
      label: "已接管",
      title: "🖥⚡ 已接管：消息发往电脑终端 pi 进程执行",
      variant: "attached",
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

/** 接管可用性：终端在线才可切 attach；否则给灰显原因 */
export interface AttachAvailability {
  attachEnabled: boolean;
  attachDisabledReason: string | null;
}

export function attachAvailability(terminal: TerminalAttachInfo | null | undefined): AttachAvailability {
  if (terminal?.online === true) return { attachEnabled: true, attachDisabledReason: null };
  return {
    attachEnabled: false,
    attachDisabledReason: "终端 pi 不在线：电脑终端需运行带 pi-command 扩展的 pi 会话",
  };
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
}

export function echoText(echo: ChannelEchoState): string {
  if (echo.channel === "attach") {
    switch (echo.phase) {
      case "sent":
        return "🖥 已发往终端，等待接收确认…";
      case "acked":
        return "🖥 终端已接收 ✓ 消息将在终端 pi 执行";
      case "failed":
        return `🖥 终端注入失败${echo.detail ? `：${echo.detail}` : ""}`;
      default:
        return "🖥 接管模式";
    }
  }
  return "📱 平行线工作中…";
}

/**
 * 会话是否走 attach 发送：用户选择 attach 且 server 未明确告知"未接管"。
 * terminal 未知（详情未加载完/旧 server）按接管尝试：服务端未接管时返回
 * ATTACH_REQUIRED 由调用方回落平行，绝不与接管中的终端抢平行通道。
 */
export function isAttachSending(attachMode: AttachMode, terminal: TerminalAttachInfo | null | undefined): boolean {
  return attachMode === "attach" && terminal?.attached !== false;
}
