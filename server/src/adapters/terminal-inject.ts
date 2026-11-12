/**
 * terminal-inject：终端注入适配器（「像在电脑上打字一样」的执行端，docs/TERMINAL_INJECT.md）。
 *
 * 通用注入策略（2026-11-12 真机探针验证，kitty send-text --stdin + cat 落盘 hex 比对）：
 * - 文本以 bracketed paste 标记（ESC[200~ … ESC[201~）包裹 → TUI 按粘贴语义收进输入框，
 *   内嵌换行不会被当成回车提前提交（探针实测 ESC 标记原样透传）；
 * - 结尾单独 \r = 真回车（pty ICRNL 转 \n，与真人按键一致）→ 提交本轮消息；
 * - 字节走 stdin 原样发送（argv 传参对 NUL/超长文本不安全，统一 stdin）。
 *
 * 适配器（发现层已在 terminal-host.ts 判定宿主）：
 * - tmux：load-buffer + paste-buffer 原样灌进 pane（任何终端模拟器通用，最优先）；
 * - kitty：kitten @ send-text --match id:<wid> --stdin（裸 kitty 场景）；
 * - wezterm：wezterm cli send-text --pane-id（同 kitty 思路）。
 */
import { execFile as nodeExecFile } from "node:child_process";
import type { TerminalHost } from "./terminal-host.js";

/** 可注入的 execFile 最小结构（返回子进程句柄以写 stdin；测试可 fake） */
export interface ExecFileWithStdin {
  (
    file: string,
    args: string[],
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): { stdin?: { end(chunk: string): void; on(event: string, cb: () => void): void } | null };
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** 注入字节 = bracketed paste 包裹文本 + 结尾真回车（提交） */
export function buildInjectBytes(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}\r`;
}

export interface SendPlan {
  bin: string;
  args: string[];
  /** 无 stdin 时为 undefined；有则作为进程 stdin 原样写入 */
  stdin?: string;
}

/** tmux 通道：load-buffer 收字节 → paste-buffer 原样灌进 pane（-d 用后即删） */
export function buildTmuxSendPlans(host: { kind: "tmux"; pane: string }, bytes: string, bufferName = "agent-hub-inject"): SendPlan[] {
  return [
    { bin: "tmux", args: ["load-buffer", "-b", bufferName, "-"], stdin: bytes },
    { bin: "tmux", args: ["paste-buffer", "-d", "-b", bufferName, "-t", host.pane] },
  ];
}

/** kitty 通道：send-text --stdin 原样送进指定窗口（探针实测 ESC 标记与 \r 语义正确） */
export function buildKittySendPlan(
  host: { kind: "kitty"; socket: string; windowId: number },
  bytes: string,
  kittenBin = "kitten",
): SendPlan {
  return { bin: kittenBin, args: ["@", "--to", host.socket, "send-text", "--match", `id:${host.windowId}`, "--stdin"], stdin: bytes };
}

/** wezterm 通道：cli send-text --pane-id（stdin 送字节） */
export function buildWeztermSendPlan(host: { kind: "wezterm"; paneId: string }, bytes: string, bin = "wezterm"): SendPlan {
  return { bin, args: ["cli", "send-text", "--pane-id", host.paneId], stdin: bytes };
}

/** 按宿主生成有序发送计划 */
export function buildSendPlans(host: TerminalHost, text: string, kittenBin = "kitten"): SendPlan[] {
  const bytes = buildInjectBytes(text);
  switch (host.kind) {
    case "tmux":
      return buildTmuxSendPlans(host, bytes);
    case "kitty":
      return [buildKittySendPlan(host, bytes, kittenBin)];
    case "wezterm":
      return [buildWeztermSendPlan(host, bytes)];
  }
}

/** kitty kitten 二进制常见位置（PATH 里没有时的兜底） */
export const KITTEN_FALLBACK_PATHS = ["/Applications/kitty.app/Contents/MacOS/kitten"];

function runPlan(plan: SendPlan, execFileFn: ExecFileWithStdin): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFileFn(plan.bin, plan.args, (err) => (err ? reject(err) : resolve()));
    if (plan.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined); // EPIPE 静默：进程早退时错误走 exit code
      child.stdin.end(plan.stdin);
    }
  });
}

/**
 * 把消息注入真 TUI（文本 + 提交回车）。kitten 不在 PATH 时按兜底路径重试一次。
 * 失败抛错（调用方决定降级/回执）；单条消息内按计划顺序串行执行。
 */
export async function injectMessage(
  host: TerminalHost,
  text: string,
  execFileFn: ExecFileWithStdin = nodeExecFile as unknown as ExecFileWithStdin,
): Promise<void> {
  const plans = buildSendPlans(host, text);
  for (let i = 0; i < plans.length; i += 1) {
    try {
      await runPlan(plans[i], execFileFn);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (host.kind === "kitty" && i === 0 && code === "ENOENT") {
        await runPlan(buildKittySendPlan(host, buildInjectBytes(text), KITTEN_FALLBACK_PATHS[0]), execFileFn);
        continue;
      }
      throw err;
    }
  }
}
