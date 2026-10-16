/**
 * 错误字段在流式管道里的透传/保留回归。
 *
 * `normalizeMessage` 是**白名单式**构造（只挑它认识的字段），所以 server 新增的 `error`
 * 必须显式加进去，否则会在 WS 入口被静默丢弃——服务端修好了也白修。
 * `withLocalFallbacks` 则要保证：权威消息没带 error 时，不要把已经显示出来的错误条闪没。
 */
import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import { applyWsEvent, reconcileMessages } from "./messageStream";

function msg(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    timestamp: 1,
    text: "",
    toolCalls: [],
    ...overrides,
  };
}

describe("applyWsEvent：message_end 的 error 透传", () => {
  it("权威消息带 error → 落到消息上（否则前端只能渲染空气泡）", () => {
    const next = applyWsEvent([], {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        timestamp: 1,
        text: "",
        toolCalls: [],
        error: { kind: "other", message: "Connection error." },
      },
    });
    expect(next).toHaveLength(1);
    expect(next[0].error).toEqual({ kind: "other", message: "Connection error." });
  });

  it("上下文溢出的 kind 原样透传（前端据此给「压缩上下文」按钮）", () => {
    const next = applyWsEvent([], {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        timestamp: 1,
        text: "",
        toolCalls: [],
        error: { kind: "contextOverflow", message: "prompt is too long" },
      },
    });
    expect(next[0].error?.kind).toBe("contextOverflow");
  });

  it("替换已有流式占位时保留 error，且清掉 streaming 标记", () => {
    const streaming = [msg({ streaming: true, text: "半句" })];
    const next = applyWsEvent(streaming, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        timestamp: 1,
        text: "半句话",
        toolCalls: [],
        error: { kind: "other", message: "Connection error." },
      },
    });
    expect(next[0].text).toBe("半句话");
    expect(next[0].error?.message).toBe("Connection error.");
    expect(next[0].streaming).toBe(false);
  });

  it("权威没带 error 时保留本地已显示的错误（错误条不得闪没）", () => {
    const local = [msg({ error: { kind: "other", message: "Connection error." } })];
    const next = applyWsEvent(local, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1, text: "", toolCalls: [] },
    });
    expect(next[0].error?.message).toBe("Connection error.");
  });

  it("无错误的普通消息不带 error 字段（不给气泡凭空加错误条）", () => {
    const next = applyWsEvent([], {
      type: "message_end",
      message: { id: "m2", role: "assistant", timestamp: 1, text: "正常回答", toolCalls: [] },
    });
    expect(next[0].error).toBeUndefined();
  });
});

describe("reconcileMessages：对账后错误仍在", () => {
  it("权威列表带 error → 对账后保留（刷新/重连不能把错误洗掉）", () => {
    const prev = [msg({ streaming: true })];
    const fresh = [msg({ text: "", error: { kind: "other", message: "Connection error." } })];
    const next = reconcileMessages(prev, fresh);
    expect(next[0].error?.message).toBe("Connection error.");
  });

  it("历史消息（非流式、无图）直接用权威列表：error 由权威决定", () => {
    const fresh = [msg({ id: "h1", error: { kind: "aborted", message: "Operation aborted" } })];
    const next = reconcileMessages([], fresh);
    expect(next).toBe(fresh);
    expect(next[0].error?.kind).toBe("aborted");
  });
});
