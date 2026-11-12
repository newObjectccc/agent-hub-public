/**
 * terminal-host 纯函数 + 发现流程单测（终端注入接管的地基，docs/TERMINAL_INJECT.md）：
 * ps/lsof 解析、宿主判定（tmux 优先于 kitty）、交互 TUI 判别（排除 headless）、
 * 发现三态（inject / no-host / none）与匹配优先级（--resume 精确 > 唯一 cwd > 最近启动）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverHost,
  hostFromEnv,
  isInteractiveTuiCommand,
  parseEtimesteconds,
  parseLsofCwd,
  parsePsEwwEnv,
  parsePsProcessTable,
  type ExecFileLike,
} from "../adapters/terminal-host.js";

describe("parseEtimesteconds / parsePsProcessTable", () => {
  it("etime 各形态（[[dd-]hh:]mm:ss）解析为秒", () => {
    assert.equal(parseEtimesteconds("05:23"), 5 * 60 + 23);
    assert.equal(parseEtimesteconds("1:05:23"), 3923);
    assert.equal(parseEtimesteconds("20769-10:13:12"), 20769 * 86400 + 10 * 3600 + 13 * 60 + 12);
    assert.equal(parseEtimesteconds("bogus"), null);
  });
  it("解析 pid/etime/command（command 含空格与路径）", () => {
    const rows = parsePsProcessTable(
      "  5913 02:00 claude\n  81 25:00:00 /Applications/kitty.app/Contents/MacOS/kitty\n  70 00:05 codex app-server\n",
    );
    assert.deepEqual(rows, [
      { pid: 5913, elapsed: 120, command: "claude" },
      { pid: 81, elapsed: 90000, command: "/Applications/kitty.app/Contents/MacOS/kitty" },
      { pid: 70, elapsed: 5, command: "codex app-server" },
    ]);
  });
  it("空输出/格式不合法行容错", () => {
    assert.deepEqual(parsePsProcessTable(""), []);
    assert.deepEqual(parsePsProcessTable("header garbage\n"), []);
  });
});

describe("isInteractiveTuiCommand", () => {
  it("交互 TUI 命中（含绝对路径）", () => {
    assert.equal(isInteractiveTuiCommand("claude", "claude"), true);
    assert.equal(isInteractiveTuiCommand("/Users/x/.nvm/versions/node/v22/bin/claude", "claude"), true);
    assert.equal(isInteractiveTuiCommand("claude --resume abc-123", "claude"), true);
  });
  it("headless/驱动形态排除（防把自己的驱动进程当 TUI）", () => {
    assert.equal(isInteractiveTuiCommand("claude -p --resume x", "claude"), false);
    assert.equal(isInteractiveTuiCommand("claude --print hi", "claude"), false);
    assert.equal(isInteractiveTuiCommand("claude -p --input-format stream-json --output-format stream-json", "claude"), false);
    assert.equal(isInteractiveTuiCommand("codex app-server", "codex"), false);
    assert.equal(isInteractiveTuiCommand("codex proto", "codex"), false);
    assert.equal(isInteractiveTuiCommand("claude-mirror", "claude"), false, "basename 精确匹配，不误命中别的二进制");
    assert.equal(isInteractiveTuiCommand("claude", "codex"), false);
  });
});

describe("parseLsofCwd / parsePsEwwEnv", () => {
  it("lsof -Fn 输出取 n 行路径", () => {
    assert.equal(parseLsofCwd("p5913\ncwd\nn/Users/peterpeng/Workspace/agent-hub-public\n"), "/Users/peterpeng/Workspace/agent-hub-public");
    assert.equal(parseLsofCwd(""), null);
  });
  it("ps eww 环境变量段解析（目标变量值无空格）", () => {
    const env = parsePsEwwEnv(
      "  PID TTY      TIME CMD\n 5913 ttys010  0:01.23 claude TERM=xterm-256color TMUX_PANE=%3 KITTY_WINDOW_ID=13 KITTY_LISTEN_ON=unix:/tmp/k.sock\n",
    );
    assert.equal(env.TMUX_PANE, "%3");
    assert.equal(env.KITTY_WINDOW_ID, "13");
    assert.equal(env.KITTY_LISTEN_ON, "unix:/tmp/k.sock");
    assert.equal(env.TERM, "xterm-256color");
  });
});

describe("hostFromEnv", () => {
  it("tmux 优先（tmux 里的进程也带 KITTY_* 变量）", () => {
    assert.deepEqual(
      hostFromEnv({ TMUX_PANE: "%3", KITTY_WINDOW_ID: "9", KITTY_LISTEN_ON: "unix:/k.sock" }),
      { kind: "tmux", pane: "%3" },
    );
  });
  it("kitty / wezterm / 无通道", () => {
    assert.deepEqual(hostFromEnv({ KITTY_WINDOW_ID: "13", KITTY_LISTEN_ON: "unix:/k.sock" }), {
      kind: "kitty",
      socket: "unix:/k.sock",
      windowId: 13,
    });
    assert.deepEqual(hostFromEnv({ WEZTERM_PANE: "5" }), { kind: "wezterm", paneId: "5" });
    assert.equal(hostFromEnv({ TERM: "xterm" }), null);
    assert.equal(hostFromEnv({ KITTY_WINDOW_ID: "not-a-number", KITTY_LISTEN_ON: "unix:/k.sock" }), null);
    assert.equal(hostFromEnv({ KITTY_WINDOW_ID: "13" }), null, "缺 KITTY_LISTEN_ON 无法注入");
  });
});

/** 可编排的 fake exec：按 (file,args) 前缀匹配返回预设输出 */
function fakeExec(handlers: Array<{ match: (file: string, args: string[]) => boolean; out: string }>): ExecFileLike {
  return ((file: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const hit = handlers.find((h) => h.match(file, args));
    if (hit) cb(null, hit.out, "");
    else cb(new Error(`unexpected: ${file} ${args.join(" ")}`), "", "");
  }) as ExecFileLike;
}

const PS_TABLE = [
  "  5913 01:40 claude --resume 8d2ccdea-419b-45ae-9c82-e251ded548e4",
  "  6000 03:20 claude",
  "  6100 05:00 claude -p --resume 8d2ccdea-419b-45ae-9c82-e251ded548e4 --input-format stream-json",
  "  7000 06:40 claude",
].join("\n");

describe("discoverHost", () => {
  it("--resume <id> 精确命中（跳过 headless 驱动进程），宿主=kitty", async () => {
    const exec = fakeExec([
      { match: (f, a) => f === "ps" && a[0] !== "eww", out: PS_TABLE },
      { match: (f, a) => f === "lsof" && a.includes("5913"), out: "p5913\ncwd\nn/w\n" },
      { match: (f, a) => f === "lsof" && a.includes("6000"), out: "p6000\ncwd\nn/w\n" },
      { match: (f, a) => f === "lsof" && a.includes("7000"), out: "p7000\ncwd\nn/other\n" },
      { match: (f, a) => f === "ps" && a[0] === "eww" && a.includes("5913"), out: " 5913 ttys010 claude KITTY_WINDOW_ID=13 KITTY_LISTEN_ON=unix:/k.sock\n" },
    ]);
    const got = await discoverHost({ cwd: "/w", sessionId: "8d2ccdea-419b-45ae-9c82-e251ded548e4", agent: "claude" }, exec);
    assert.deepEqual(got, { pid: 5913, host: { kind: "kitty", socket: "unix:/k.sock", windowId: 13 }, ambiguous: false });
  });

  it("多候选无精确命中：取最近启动并标 ambiguous", async () => {
    const exec = fakeExec([
      { match: (f, a) => f === "ps" && a[0] !== "eww", out: PS_TABLE },
      { match: (f, a) => f === "lsof" && a.includes("5913"), out: "p5913\ncwd\nn/w\n" },
      { match: (f, a) => f === "lsof" && a.includes("6000"), out: "p6000\ncwd\nn/w/\n" },
      { match: (f, a) => f === "ps" && a[0] === "eww" && a.includes("5913"), out: " 5913 ttys010 claude TMUX_PANE=%2\n" },
    ]);
    const got = await discoverHost({ cwd: "/w", sessionId: "no-such-id", agent: "claude" }, exec);
    assert.deepEqual(got, { pid: 5913, host: { kind: "tmux", pane: "%2" }, ambiguous: true }, "01:40 < 03:20 取 5913，尾斜杠路径归一命中");
  });

  it("TUI 在跑但宿主无注入通道 → host:null（不可接管）", async () => {
    const exec = fakeExec([
      { match: (f, a) => f === "ps" && a[0] !== "eww", out: PS_TABLE },
      { match: (f, a) => f === "lsof" && a.includes("6000"), out: "p6000\ncwd\nn/w\n" },
      { match: (f, a) => f === "ps" && a[0] === "eww", out: " 6000 ttys010 claude TERM=xterm\n" },
    ]);
    const got = await discoverHost({ cwd: "/w", sessionId: "x", agent: "claude" }, exec);
    assert.deepEqual(got, { pid: 6000, host: null, ambiguous: false });
  });

  it("无 TUI（cwd 不匹配 / 全 headless）→ null 可走后台", async () => {
    const exec = fakeExec([
      { match: (f, a) => f === "ps" && a[0] !== "eww", out: PS_TABLE },
      { match: (f, a) => f === "lsof" && a.includes("5913"), out: "p5913\ncwd\nn/elsewhere\n" },
    ]);
    assert.equal(await discoverHost({ cwd: "/w", sessionId: "x", agent: "claude" }, exec), null);
  });
});
