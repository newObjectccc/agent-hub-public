/**
 * 双模式会话驱动（E3）纯逻辑测试：模式持久化、发送模式映射、
 * 徽章文案、接管可用性、发送归属状态条、attach 发送判定。
 */
import { describe, expect, it } from "vitest";
import {
  attachAvailability,
  attachBadge,
  attachModePinnedKey,
  echoText,
  isAttachSending,
  loadAttachMode,
  loadIntroSeen,
  loadPinnedAttachMode,
  mapAttachSendMode,
  markIntroSeen,
  pinAttachMode,
  saveAttachMode,
  type ChannelEchoState,
} from "./attach";

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("attach: 模式持久化", () => {
  it("用户手动选择（modePinned）：记录/读取用户模式；无记录/损坏 → null（允许智能默认）", () => {
    const storage = fakeStorage();
    expect(loadPinnedAttachMode(storage, "s1")).toBeNull();
    pinAttachMode(storage, "s1", "parallel");
    expect(loadPinnedAttachMode(storage, "s1")).toBe("parallel");
    pinAttachMode(storage, "s1", "attach");
    expect(loadPinnedAttachMode(storage, "s1")).toBe("attach");
    expect(loadPinnedAttachMode(storage, "s2")).toBeNull();
    // pin 与生效模式分键存储：自动默认/校正写入的 attachModeKey 不等于用户选择记录
    expect(storage.getItem(attachModePinnedKey("s1"))).toBe("attach");

    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadPinnedAttachMode(broken, "s1")).toBeNull();
    expect(() => pinAttachMode(broken, "s1", "attach")).not.toThrow();
  });

  it("默认 parallel；保存/读取 per-session；损坏存储回落 parallel", () => {
    const storage = fakeStorage();
    expect(loadAttachMode(storage, "s1")).toBe("parallel");
    saveAttachMode(storage, "s1", "attach");
    expect(loadAttachMode(storage, "s1")).toBe("attach");
    expect(loadAttachMode(storage, "s2")).toBe("parallel");

    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadAttachMode(broken, "s1")).toBe("parallel");
    expect(() => saveAttachMode(broken, "s1", "attach")).not.toThrow();
  });

  it("首次说明 sheet 标记只记一次（存储不可用不再打扰）", () => {
    const storage = fakeStorage();
    expect(loadIntroSeen(storage)).toBe(false);
    markIntroSeen(storage);
    expect(loadIntroSeen(storage)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadIntroSeen(broken)).toBe(true);
  });
});

describe("attach: 发送模式映射与发送判定", () => {
  it("auto → followUp（空闲即发/正忙排队，同 parallel auto 降级语义）；手动模式透传", () => {
    expect(mapAttachSendMode("auto")).toBe("followUp");
    expect(mapAttachSendMode("prompt")).toBe("prompt");
    expect(mapAttachSendMode("steer")).toBe("steer");
    expect(mapAttachSendMode("followUp")).toBe("followUp");
  });

  it("isAttachSending：选择 attach 且 server 未明确未接管才走指令队列（详情未加载完按接管尝试）", () => {
    expect(isAttachSending("attach", { online: true, attached: true })).toBe(true);
    expect(isAttachSending("attach", null)).toBe(true);
    expect(isAttachSending("attach", undefined)).toBe(true);
    expect(isAttachSending("attach", { online: true, attached: false })).toBe(false);
    expect(isAttachSending("attach", { online: false, attached: false })).toBe(false);
    expect(isAttachSending("parallel", { online: true, attached: true })).toBe(false);
  });
});

describe("attach: 徽章文案与接管可用性", () => {
  it("三态徽章：🖥⚡ 已接管 / 🖥 终端在线 / 📱 平行线；claude 等无状态不显示", () => {
    expect(attachBadge({ online: true, attached: true })?.variant).toBe("attached");
    expect(attachBadge({ online: true, attached: true })?.label).toBe("已接管");
    expect(attachBadge({ online: true, attached: false })?.label).toBe("终端在线");
    expect(attachBadge({ online: false, attached: false })?.label).toBe("平行线");
    expect(attachBadge(null)).toBeNull();
    expect(attachBadge(undefined)).toBeNull();
  });

  it("接管可用性：在线可切；离线灰显带原因", () => {
    expect(attachAvailability({ online: true, attached: false })).toEqual({
      attachEnabled: true,
      attachDisabledReason: null,
    });
    const offline = attachAvailability({ online: false, attached: false });
    expect(offline.attachEnabled).toBe(false);
    expect(offline.attachDisabledReason).toMatch(/终端 pi 不在线/);
    expect(attachAvailability(null).attachEnabled).toBe(false);
  });
});

describe("attach: 发送归属状态条文案", () => {
  it("attach：已发往终端 / 终端已接收 / 注入失败带原因", () => {
    const sent: ChannelEchoState = { channel: "attach", phase: "sent" };
    expect(echoText(sent)).toMatch(/已发往终端/);
    expect(echoText({ channel: "attach", phase: "acked" })).toMatch(/终端已接收/);
    expect(echoText({ channel: "attach", phase: "failed", detail: "终端正忙" })).toMatch(/注入失败：终端正忙/);
    expect(echoText({ channel: "attach", phase: "failed", detail: null })).toMatch(/注入失败/);
  });

  it("parallel：平行线工作中", () => {
    expect(echoText({ channel: "parallel", phase: "working" })).toMatch(/平行线工作中/);
  });
});
