/**
 * 会话完结提醒（横幅/震动/提示音）的纯逻辑与副作用薄封装。
 *
 * - 决策（shouldAlert / alertChannels）为纯函数，单测覆盖
 * - 副作用（vibrate / playChime）依赖可注入，测试用 mock
 * - 设置存 localStorage（可静音），无服务端依赖
 */
import type { NotificationKind } from "../api/types";

export interface NotifySettings {
  /** 提示音 */
  sound: boolean;
  /** 震动（navigator.vibrate，不支持时优雅降级） */
  vibrate: boolean;
  /** 应用内横幅 */
  banner: boolean;
}

export const NOTIFY_SETTINGS_KEY = "agent-hub.notify.settings";

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { sound: true, vibrate: true, banner: true };

export const ALERT_KINDS: readonly NotificationKind[] = ["settled", "error"];

/** 未知/非法配置安全回落默认（纯函数） */
export function parseNotifySettings(raw: unknown): NotifySettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_NOTIFY_SETTINGS };
  const record = raw as Record<string, unknown>;
  const pick = (key: keyof NotifySettings): boolean =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_NOTIFY_SETTINGS[key];
  return { sound: pick("sound"), vibrate: pick("vibrate"), banner: pick("banner") };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadNotifySettings(storage: StorageLike | null | undefined): NotifySettings {
  if (!storage) return { ...DEFAULT_NOTIFY_SETTINGS };
  try {
    const raw = storage.getItem(NOTIFY_SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_NOTIFY_SETTINGS };
    return parseNotifySettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
}

export function saveNotifySettings(storage: StorageLike | null | undefined, settings: NotifySettings): void {
  if (!storage) return;
  try {
    storage.setItem(NOTIFY_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式等写入失败：忽略，本次会话内设置仍生效
  }
}

export interface AlertChannels {
  banner: boolean;
  sound: boolean;
  vibrate: boolean;
}

/** 会话完结（settled）与出错（error）提醒各通道是否开启（纯函数） */
export function alertChannels(kind: NotificationKind, settings: NotifySettings): AlertChannels {
  const isAlertKind = ALERT_KINDS.includes(kind);
  return {
    banner: isAlertKind && settings.banner,
    sound: isAlertKind && settings.sound,
    vibrate: isAlertKind && settings.vibrate,
  };
}

export function shouldAlert(kind: NotificationKind, settings: NotifySettings): boolean {
  const channels = alertChannels(kind, settings);
  return channels.banner || channels.sound || channels.vibrate;
}

/** 短震（手机）；不支持 navigator.vibrate 时静默返回 false */
export function vibrate(
  pattern: number | number[] = 120,
  nav?: { vibrate?: (p: number | number[]) => boolean } | null,
): boolean {
  const target = nav === undefined ? (typeof navigator !== "undefined" ? navigator : null) : nav;
  if (!target || typeof target.vibrate !== "function") return false;
  try {
    return target.vibrate(pattern) !== false;
  } catch {
    return false;
  }
}

/** WebAudio 最小接口（便于 mock） */
export interface AudioContextLike {
  currentTime: number;
  destination: unknown;
  /** 可选：自动播放解锁状态 */
  state?: string;
  resume?(): Promise<void> | void;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(node: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, time: number): void;
      exponentialRampToValueAtTime(value: number, time: number): void;
    };
    connect(node: unknown): unknown;
  };
}

function defaultAudioContextFactory(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor() as unknown as AudioContextLike;
  } catch {
    return null;
  }
}

/** 共享 AudioContext（首次用户手势 primeAudio 解锁后可发声） */
let sharedCtx: AudioContextLike | null = null;

export function getAudioContext(factory: () => AudioContextLike | null = defaultAudioContextFactory): AudioContextLike | null {
  if (sharedCtx) return sharedCtx;
  sharedCtx = factory();
  return sharedCtx;
}

/** 首次用户手势时调用：创建/resume AudioContext，解锁移动端自动播放限制 */
export function primeAudio(): boolean {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

/**
 * 短促提示音（两声上行“叮-咚”，~350ms，音量克制）。
 * 浏览器自动播放限制下，AudioContext 可能 suspended——静默降级不抛错。
 */
export function playChime(factory?: () => AudioContextLike | null): boolean {
  const ctx = factory ? factory() : getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") void ctx.resume();
    const notes: Array<{ freq: number; at: number; dur: number }> = [
      { freq: 880, at: 0, dur: 0.12 },
      { freq: 1174.66, at: 0.16, dur: 0.18 },
    ];
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square"; // 野兽派：干脆利落的方波短音
      osc.frequency.value = note.freq;
      const t0 = ctx.currentTime + note.at;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + note.dur + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}
