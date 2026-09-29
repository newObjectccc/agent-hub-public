/**
 * 会话完结提醒（横幅/震动/提示音）纯逻辑单测：
 * 设置解析/持久化、提醒通道决策、vibrate/playChime 副作用（mock 注入）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alertChannels,
  DEFAULT_NOTIFY_SETTINGS,
  loadNotifySettings,
  NOTIFY_SETTINGS_KEY,
  parseNotifySettings,
  playChime,
  saveNotifySettings,
  shouldAlert,
  vibrate,
  type AudioContextLike,
} from "./notify";
import { notifyAlert } from "../components/NoticeBanner";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => map.delete(k) as unknown as void,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notify: 设置解析与持久化", () => {
  it("parseNotifySettings：合法值透传", () => {
    expect(parseNotifySettings({ sound: false, vibrate: true, banner: false })).toEqual({
      sound: false,
      vibrate: true,
      banner: false,
    });
  });

  it("parseNotifySettings：非法/缺失字段回落默认，未知字段忽略", () => {
    expect(parseNotifySettings({ sound: "yes", vibrate: 1, extra: 1 })).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(parseNotifySettings(null)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(parseNotifySettings("garbage")).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });

  it("load/save 往返；损坏 JSON 回落默认；无 storage 不抛", () => {
    const storage = memoryStorage();
    saveNotifySettings(storage, { sound: false, vibrate: false, banner: true });
    expect(loadNotifySettings(storage)).toEqual({ sound: false, vibrate: false, banner: true });

    const broken = memoryStorage({ [NOTIFY_SETTINGS_KEY]: "{oops" });
    expect(loadNotifySettings(broken)).toEqual(DEFAULT_NOTIFY_SETTINGS);

    expect(loadNotifySettings(null)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(() => saveNotifySettings(null, DEFAULT_NOTIFY_SETTINGS)).not.toThrow();
  });
});

describe("notify: 提醒通道决策（纯函数）", () => {
  it("settled/error 走全部通道；steering/done 不提醒", () => {
    expect(alertChannels("settled", DEFAULT_NOTIFY_SETTINGS)).toEqual({ banner: true, sound: true, vibrate: true });
    expect(alertChannels("error", DEFAULT_NOTIFY_SETTINGS)).toEqual({ banner: true, sound: true, vibrate: true });
    expect(shouldAlert("steering", DEFAULT_NOTIFY_SETTINGS)).toBe(false);
    expect(shouldAlert("done", DEFAULT_NOTIFY_SETTINGS)).toBe(false);
  });

  it("逐通道静音：全部关掉则 shouldAlert=false", () => {
    const muted = { sound: false, vibrate: false, banner: true };
    expect(alertChannels("settled", muted)).toEqual({ banner: true, sound: false, vibrate: false });
    expect(shouldAlert("settled", muted)).toBe(true);
    expect(shouldAlert("settled", { sound: false, vibrate: false, banner: false })).toBe(false);
  });
});

describe("notify: 震动与提示音（mock 注入）", () => {
  it("vibrate：调用 navigator.vibrate；不支持/抛错时返回 false", () => {
    const vibrateFn = vi.fn(() => true);
    expect(vibrate(120, { vibrate: vibrateFn })).toBe(true);
    expect(vibrateFn).toHaveBeenCalledWith(120);

    expect(vibrate(120, {})).toBe(false);
    expect(vibrate(120, null)).toBe(false);
    expect(
      vibrate(120, {
        vibrate: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });

  it("playChime：两声短音（880Hz → 1174.66Hz），无 AudioContext 时降级", () => {
    const freqs: number[] = [];
    const started: number[] = [];
    const makeCtx = (): AudioContextLike => ({
      currentTime: 10,
      destination: {},
      createOscillator: () => {
        const frequency = { value: 0 };
        let value = 0;
        Object.defineProperty(frequency, "value", {
          get: () => value,
          set: (v: number) => {
            value = v;
            freqs.push(v);
          },
        });
        return {
          type: "square",
          frequency,
          connect: (node: unknown) => node,
          start: (when?: number) => void started.push(when ?? -1),
          stop: () => undefined,
        };
      },
      createGain: () => ({
        gain: {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: (node: unknown) => node,
      }),
    });
    expect(playChime(makeCtx)).toBe(true);
    expect(freqs).toEqual([880, 1174.66]);
    expect(started.length).toBe(2);
    expect(playChime(() => null)).toBe(false);
  });

  it("notifyAlert：按设置逐通道触发（横幅 + 震动 mock）", () => {
    const vibrateFn = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate: vibrateFn });

    const on = notifyAlert(
      {
        id: "n1",
        sessionId: "s1",
        sessionName: "会话",
        kind: "settled",
        text: "干完了",
        timestamp: "2026-02-18T12:00:00.000Z",
        read: false,
      },
      { sound: false, vibrate: true, banner: true },
    );
    expect(on).toEqual({ banner: true, vibrated: true, sounded: false });
    expect(vibrateFn).toHaveBeenCalledTimes(1);

    const off = notifyAlert(
      {
        id: "n2",
        sessionId: "s1",
        sessionName: null,
        kind: "steering",
        text: "插话",
        timestamp: "2026-02-18T12:00:00.000Z",
        read: false,
      },
      { sound: true, vibrate: true, banner: true },
    );
    expect(off).toEqual({ banner: false, vibrated: false, sounded: false });
    expect(vibrateFn).toHaveBeenCalledTimes(1); // steering 不震动
  });
});
