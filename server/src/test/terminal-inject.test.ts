/**
 * terminal-inject 单测（终端注入适配器）：注入字节（bracketed paste + 提交回车）、
 * tmux/kitty/wezterm 发送计划、kitten ENOENT 兜底路径。
 * 语义依据：2026-11-12 kitty send-text --stdin 真机探针（ESC 标记与 \r 原样透传）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInjectBytes,
  buildKittySendPlan,
  buildSendPlans,
  buildTmuxSendPlans,
  buildWeztermSendPlan,
  injectMessage,
  KITTEN_FALLBACK_PATHS,
  PASTE_END,
  PASTE_START,
  type ExecFileWithStdin,
} from "../adapters/terminal-inject.js";

describe("buildInjectBytes", () => {
  it("bracketed paste 包裹 + 结尾提交回车", () => {
    assert.equal(buildInjectBytes("hi"), `${PASTE_START}hi${PASTE_END}\r`);
    assert.equal(buildInjectBytes("a\nb"), `${PASTE_START}a\nb${PASTE_END}\r`, "内嵌换行留在粘贴区，不被当回车提交");
  });
});

describe("发送计划", () => {
  it("tmux：load-buffer 收字节 → paste-buffer 原样灌 pane", () => {
    const plans = buildTmuxSendPlans({ kind: "tmux", pane: "%3" }, "BYTES");
    assert.equal(plans.length, 2);
    assert.deepEqual(plans[0], { bin: "tmux", args: ["load-buffer", "-b", "agent-hub-inject", "-"], stdin: "BYTES" });
    assert.deepEqual(plans[1], { bin: "tmux", args: ["paste-buffer", "-d", "-b", "agent-hub-inject", "-t", "%3"] });
  });
  it("kitty：send-text --match id:N --stdin", () => {
    const plan = buildKittySendPlan({ kind: "kitty", socket: "unix:/k.sock", windowId: 13 }, "BYTES");
    assert.deepEqual(plan, {
      bin: "kitten",
      args: ["@", "--to", "unix:/k.sock", "send-text", "--match", "id:13", "--stdin"],
      stdin: "BYTES",
    });
  });
  it("wezterm：cli send-text --pane-id", () => {
    const plan = buildWeztermSendPlan({ kind: "wezterm", paneId: "5" }, "BYTES");
    assert.deepEqual(plan, { bin: "wezterm", args: ["cli", "send-text", "--pane-id", "5"], stdin: "BYTES" });
  });
  it("buildSendPlans 按宿主分发且自带注入字节", () => {
    const [plan] = buildSendPlans({ kind: "kitty", socket: "s", windowId: 2 }, "hi");
    assert.equal(plan.stdin, buildInjectBytes("hi"));
  });
});

describe("injectMessage", () => {
  it("计划顺序串行执行（tmux 两步）", async () => {
    const calls: string[][] = [];
    const exec = ((file: string, args: string[], cb: (err: Error | null) => void) => {
      calls.push([file, ...args]);
      cb(null);
      return { stdin: { end: () => undefined, on: () => undefined } };
    }) as unknown as ExecFileWithStdin;
    await injectMessage({ kind: "tmux", pane: "%1" }, "x", exec);
    assert.deepEqual(calls.map((c) => c[1]), ["load-buffer", "paste-buffer"]);
  });

  it("kitty kitten ENOENT 时按兜底路径重试", async () => {
    const calls: string[] = [];
    let first = true;
    const exec = ((file: string, _args: string[], cb: (err: Error | null) => void) => {
      calls.push(file);
      if (first) {
        first = false;
        cb(Object.assign(new Error("not found"), { code: "ENOENT" }));
      } else cb(null);
      return { stdin: { end: () => undefined, on: () => undefined } };
    }) as unknown as ExecFileWithStdin;
    await injectMessage({ kind: "kitty", socket: "s", windowId: 1 }, "x", exec);
    assert.deepEqual(calls, ["kitten", KITTEN_FALLBACK_PATHS[0]]);
  });

  it("非 ENOENT 失败直接抛出（调用方决定降级）", async () => {
    const exec = ((_f: string, _a: string[], cb: (err: Error | null) => void) => {
      cb(Object.assign(new Error("boom"), { code: "EFAIL" }));
      return { stdin: { end: () => undefined, on: () => undefined } };
    }) as unknown as ExecFileWithStdin;
    await assert.rejects(() => injectMessage({ kind: "kitty", socket: "s", windowId: 1 }, "x", exec), /boom/);
  });
});
