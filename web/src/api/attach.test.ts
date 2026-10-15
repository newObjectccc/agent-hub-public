/**
 * 双模式会话驱动（E3）纯逻辑测试：模式持久化、发送模式映射、
 * 徽章文案、接管可用性、发送归属状态条、attach 发送判定、
 * 智能默认策略（D3 defaultPolicy：active-only|always|never）。
 */
import { describe, expect, it } from "vitest";
import {
  attachAvailability,
  attachBadge,
  attachDefaultWorthy,
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

  it("isAttachSending：选择 attach 且 server 明确有 terminal 才走指令队列（attached!==false 语义保留）", () => {
    expect(isAttachSending("attach", { online: true, attached: true })).toBe(true);
    expect(isAttachSending("attach", { online: true, attached: false })).toBe(false);
    expect(isAttachSending("attach", { online: false, attached: false })).toBe(false);
    expect(isAttachSending("parallel", { online: true, attached: true })).toBe(false);
  });

  it("isAttachSending：terminal 缺失（null/undefined）→ 不走 attach 发送通道（残留 attach 模式不卡死）", () => {
    // claudeDriver.enabled=false / 老 server 不下发 terminal：不可接管即不该走 attach 发送，
    // 否则 server 400「claude 会话接管未启用」，detach 也 400，用户卡死当场无法切换
    expect(isAttachSending("attach", null)).toBe(false);
    expect(isAttachSending("attach", undefined)).toBe(false);
    expect(isAttachSending("parallel", null)).toBe(false);
    expect(isAttachSending("parallel", undefined)).toBe(false);
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

  it("灰显原因按 source 区分：codex 明示暂不支持（不误报终端 pi 不在线）", () => {
    const codex = attachAvailability(null, "codex");
    expect(codex.attachEnabled).toBe(false);
    expect(codex.attachDisabledReason).toMatch(/codex 会话暂不支持接管终端/);
    expect(codex.attachDisabledReason).not.toMatch(/pi/);
    const claudeOld = attachAvailability(null, "claude");
    expect(claudeOld.attachDisabledReason).toMatch(/v0\.3/);
  });

  it("claude 灰显文案覆盖旧 server 与 claudeDriver.enabled=false 两种情况", () => {
    // 旧 server（无 claude 接管）与新 server 配置关掉 claudeDriver.enabled 都走同一句，
    // 文案须同时点到版本（v0.3+）与配置开关（claudeDriver.enabled）
    const claude = attachAvailability(null, "claude");
    expect(claude.attachEnabled).toBe(false);
    expect(claude.attachDisabledReason).toBe(
      "暂无法接管：server 未启用 claude 接管（需 v0.3+ 且 claudeDriver.enabled）",
    );
    expect(claude.attachDisabledReason).toMatch(/未启用 claude 接管/);
    expect(claude.attachDisabledReason).toMatch(/claudeDriver\.enabled/);
    expect(claude.attachDisabledReason).toMatch(/v0\.3/);
  });

  it("hub 形态（claude）恒可接管；徽章未接管仅活跃会话显示「可接管」", () => {
    expect(attachAvailability({ online: true, attached: false, driver: "hub" })).toEqual({
      attachEnabled: true,
      attachDisabledReason: null,
    });
    expect(attachBadge({ online: true, attached: false, driver: "hub" }, "running")?.label).toBe("可接管");
    expect(attachBadge({ online: true, attached: false, driver: "hub" }, "idle")).toBeNull();
    expect(attachBadge({ online: true, attached: true, driver: "hub" })?.title).toMatch(/hub 驱动 claude/);
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

describe("attach: 智能默认策略 defaultPolicy（D3）", () => {
  it("defaultPolicy 缺省（老 server）/ active-only：行为不变（活跃才默认接管）", () => {
    // hub（claude）：running 或 lastDrivenBy=terminal 才默认接管；历史空闲不接管
    expect(attachDefaultWorthy({ status: "running" }, { online: true, attached: false, driver: "hub" })).toBe(true);
    expect(
      attachDefaultWorthy({ status: "idle", lastDrivenBy: "terminal" }, { online: true, attached: false, driver: "hub" }),
    ).toBe(true);
    expect(
      attachDefaultWorthy({ status: "idle", lastDrivenBy: "panel" }, { online: true, attached: false, driver: "hub" }),
    ).toBe(false);
    // 显式 "active-only" 与缺省同行为
    expect(
      attachDefaultWorthy({ status: "running" }, { online: true, attached: false, driver: "hub", defaultPolicy: "active-only" }),
    ).toBe(true);
    expect(
      attachDefaultWorthy({ status: "idle", lastDrivenBy: "panel" }, { online: true, attached: false, driver: "hub", defaultPolicy: "active-only" }),
    ).toBe(false);
    // pi（driver 缺省/"queue"）：终端在线即默认接管
    expect(attachDefaultWorthy({ status: "idle" }, { online: true, attached: false })).toBe(true);
    expect(attachDefaultWorthy({ status: "running" }, { online: true, attached: false, driver: "queue" })).toBe(true);
    expect(attachDefaultWorthy({ status: "running" }, { online: false, attached: false })).toBe(false);
    // 无 terminal → 不接管
    expect(attachDefaultWorthy({ status: "running" }, null)).toBe(false);
    expect(attachDefaultWorthy({ status: "running" }, undefined)).toBe(false);
  });

  it("never：活跃会话也不默认接管（只手动；pinned 优先由 ChatPage 保证）", () => {
    expect(
      attachDefaultWorthy({ status: "running" }, { online: true, attached: false, driver: "hub", defaultPolicy: "never" }),
    ).toBe(false);
    expect(
      attachDefaultWorthy({ status: "idle", lastDrivenBy: "terminal" }, { online: true, attached: false, driver: "hub", defaultPolicy: "never" }),
    ).toBe(false);
    expect(attachDefaultWorthy({ status: "running" }, { online: true, attached: false, defaultPolicy: "never" })).toBe(false);
  });

  it("always：历史空闲也默认接管；但接管当下不可行（pi 离线）仍 false", () => {
    // 历史空闲 claude（status≠running 且 lastDrivenBy≠terminal）→ true（与 active-only 的区别）
    expect(
      attachDefaultWorthy({ status: "idle", lastDrivenBy: "panel" }, { online: true, attached: false, driver: "hub", defaultPolicy: "always" }),
    ).toBe(true);
    expect(
      attachDefaultWorthy({ status: "idle" }, { online: true, attached: false, driver: "hub", defaultPolicy: "always" }),
    ).toBe(true);
    // 活跃会话照常 true
    expect(
      attachDefaultWorthy({ status: "running" }, { online: true, attached: false, driver: "hub", defaultPolicy: "always" }),
    ).toBe(true);
    // pi 在线 → true；pi 离线（接管当下不可行）→ 仍 false
    expect(attachDefaultWorthy({ status: "idle" }, { online: true, attached: false, defaultPolicy: "always" })).toBe(true);
    expect(attachDefaultWorthy({ status: "running" }, { online: false, attached: false, defaultPolicy: "always" })).toBe(false);
  });
});
