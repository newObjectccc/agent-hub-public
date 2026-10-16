/**
 * 模型错误可见性回归（P0：流式错误被吞成「（无内容）」）。
 *
 * 修复前：pi 的余额耗尽 / Connection error / 上下文溢出都**不抛异常**，只落在 assistant 消息的
 * stopReason+errorMessage 上；server DTO 不取这两个字段 → 手机端只剩一个灰色「（无内容）」气泡，
 * 零原因、零出路（实测用户语料里就有 "You have no credits remaining…"、"Connection error."）。
 *
 * 本文件钉死：错误条渲染、原文透出、上下文溢出的一键自救按钮、aborted 的弱化语气，
 * 以及「有错误时绝不再显示（无内容）」这条核心行为。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../api/types";
import { describeMessageError, MessageBubble } from "./MessageBubble";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function render(message: SessionMessage, props: { onCompact?: () => void } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<MessageBubble message={message} {...props} />);
  });
  return container;
}

function assistant(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    timestamp: 1,
    text: "",
    toolCalls: [],
    ...overrides,
  };
}

describe("describeMessageError：错误分类 → 可行动文案（纯函数）", () => {
  it("无错误返回 null", () => {
    expect(describeMessageError(undefined)).toBeNull();
  });

  it("普通模型/网络错误：透出原文，语气为 error，不提供压缩", () => {
    const info = describeMessageError({ kind: "other", message: "Connection error." });
    expect(info).not.toBeNull();
    expect(info!.tone).toBe("error");
    expect(info!.canCompact).toBe(false);
    expect(info!.text).toContain("Connection error.");
  });

  it("余额耗尽这类真实语料：原文必须完整可见（不能被美化掉）", () => {
    const raw = "You have no credits remaining. Add credits to continue using the API at https://example.com/billing.";
    const info = describeMessageError({ kind: "other", message: raw });
    expect(info!.text).toContain(raw);
  });

  it("上下文溢出：标记为可自救（前端据此给「压缩上下文」按钮）", () => {
    const info = describeMessageError({ kind: "contextOverflow", message: "prompt is too long" });
    expect(info!.canCompact).toBe(true);
    expect(info!.tone).toBe("error");
    expect(info!.text).toContain("上下文已满");
  });

  it("用户主动中止：语气弱化，不该长得像报错", () => {
    const info = describeMessageError({ kind: "aborted", message: "Operation aborted" });
    expect(info!.tone).toBe("muted");
    expect(info!.canCompact).toBe(false);
  });

  it("aborted 且无原文：给中文兜底而不是空白", () => {
    expect(describeMessageError({ kind: "aborted", message: "" })!.text).toBe("本轮已中止");
  });
});

describe("MessageBubble：错误条渲染", () => {
  it("空气泡 + 错误 → 显示错误条，绝不显示「（无内容）」", () => {
    const el = render(assistant({ error: { kind: "other", message: "Connection error." } }));
    expect(el.querySelector(".msg-error")).not.toBeNull();
    expect(el.querySelector(".msg-error")?.getAttribute("role")).toBe("alert");
    expect(el.textContent).toContain("Connection error.");
    expect(el.textContent).not.toContain("（无内容）");
  });

  it("无错误的空气泡仍显示「（无内容）」（原行为不回退）", () => {
    const el = render(assistant());
    expect(el.querySelector(".msg-error")).toBeNull();
    expect(el.textContent).toContain("（无内容）");
  });

  it("部分输出后失败：正文与错误条并存（不能只显示其一）", () => {
    const el = render(assistant({ text: "半句话", error: { kind: "other", message: "Connection error." } }));
    expect(el.textContent).toContain("半句话");
    expect(el.querySelector(".msg-error")).not.toBeNull();
  });

  it("上下文溢出 + 给了 onCompact → 出现「压缩上下文」按钮且可点", () => {
    const onCompact = vi.fn();
    const el = render(assistant({ error: { kind: "contextOverflow", message: "prompt is too long" } }), { onCompact });
    const btn = el.querySelector<HTMLButtonElement>(".msg-error-action");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("压缩上下文");
    act(() => {
      btn!.click();
    });
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("上下文溢出但没给 onCompact（claude/codex 源）→ 不渲染死按钮", () => {
    const el = render(assistant({ error: { kind: "contextOverflow", message: "prompt is too long" } }));
    expect(el.querySelector(".msg-error-action")).toBeNull();
    // 原因仍然要说清楚
    expect(el.textContent).toContain("上下文已满");
  });

  it("aborted → 弱化样式（.muted），不挂 role=alert（不吓用户）", () => {
    const el = render(assistant({ error: { kind: "aborted", message: "Operation aborted" } }));
    const box = el.querySelector(".msg-error");
    expect(box).not.toBeNull();
    expect(box!.classList.contains("muted")).toBe(true);
    expect(box!.getAttribute("role")).toBeNull();
  });

  it("流式进行中不显示错误条（还没结束，别提前报错）", () => {
    const el = render(assistant({ streaming: true, error: { kind: "other", message: "x" } }));
    // streaming 占位优先；错误条要等 settle 后（message_end 权威回填）再出现
    expect(el.textContent).not.toContain("（无内容）");
  });

  it("user 消息不带错误条（server 只对 assistant 提取 stopReason）", () => {
    const el = render({ ...assistant(), role: "user", error: { kind: "other", message: "x" } });
    expect(el.querySelector(".msg-error")).toBeNull();
  });
});
