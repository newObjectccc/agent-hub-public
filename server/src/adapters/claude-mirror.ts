/**
 * claude-mirror：hub 驱动接管的终端投屏（D7）——tmux 命名 session + 无依赖渲染器。
 *
 * 形态：attach 成功后 `tmux new-session -d -s hub-<id8> "node cli/mirror.js --file <sessionFile>"`；
 * 用户在电脑终端 `tmux attach -t hub-<id8>` 实时观看（detach 后 pane 打印 resume 提示退出）。
 * 无 tmux → hasTmux()=false → driver 记 mirror:false，接管功能不受影响（hint 提示投屏不可用）。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../paths.js";

export interface TmuxSpawnPlan {
  bin: string;
  args: string[];
  sessionName: string;
}

/** tmux 命名：hub-<sessionId 前 8 位去连字符>（tmux 名字允许的字符集） */
export function mirrorSessionName(sessionId: string): string {
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).padEnd(8, "x");
  return `hub-${short}`;
}

/** spawn 计划纯函数（可单测，仿 terminal.ts buildTtydSpawnPlan 风格） */
export function buildTmuxSpawnPlan(sessionId: string, sessionFile: string, mirrorScriptPath?: string): TmuxSpawnPlan {
  const script = mirrorScriptPath ?? join(repoRoot, "cli", "mirror.js");
  const sessionName = mirrorSessionName(sessionId);
  // tmux 命令行的引号安全：路径含单引号时用 sh 转义包裹（node 参数走 POSIX 单引号规则）
  const cmd = `node ${shQuote(script)} --file ${shQuote(sessionFile)} --label ${shQuote(sessionId)}`;
  return {
    bin: "tmux",
    args: ["new-session", "-d", "-s", sessionName, cmd],
    sessionName,
  };
}

/** POSIX shell 单引号包裹（路径含空格/引号安全） */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** 探测 tmux 可用性（一次性，调用方缓存结果） */
export function hasTmux(execFileFn: ExecFileLike = execFile as unknown as ExecFileLike): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFileFn("tmux", ["-V"], (err) => resolve(err === null));
    } catch {
      resolve(false);
    }
  });
}

export function startMirror(
  sessionId: string,
  sessionFile: string,
  execFileFn: ExecFileLike = execFile as unknown as ExecFileLike,
  mirrorScriptPath?: string,
): Promise<TmuxSpawnPlan | null> {
  const plan = buildTmuxSpawnPlan(sessionId, sessionFile, mirrorScriptPath);
  return new Promise((resolve) => {
    try {
      execFileFn(plan.bin, plan.args, (err) => resolve(err === null ? plan : null));
    } catch {
      resolve(null);
    }
  });
}

export function stopMirror(
  sessionId: string,
  execFileFn: ExecFileLike = execFile as unknown as ExecFileLike,
): void {
  try {
    execFileFn("tmux", ["kill-session", "-t", mirrorSessionName(sessionId)], () => undefined);
  } catch {
    /* 静默 */
  }
}
