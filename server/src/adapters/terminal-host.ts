/**
 * terminal-host：终端在场发现（「终端注入」接管形态的地基，docs/TERMINAL_INJECT.md）。
 *
 * 任务：给定会话（cwd + agent 源 + sessionId [+ sessionFile]），找到电脑上正在跑的交互 TUI
 * 进程，并判定它宿主在哪个终端通道（tmux / kitty / wezterm / 无注入通道）。全程只读
 * （ps / lsof），不做任何注入（注入在 terminal-inject.ts）。
 *
 * 匹配策略（由强到弱）：
 * 1. argv 含 `--resume <sessionId>` → 精确命中；
 * 2. cwd 命中的候选唯一 → 直接用（常见形态：一个项目一个窗口）；
 * 3. 多候选 → 取 etimes 最小者（最近启动）并标 ambiguous。真 TUI 不持有会话文件句柄
 *    （lsof 实测无 jsonl 打开），pid↔sessionId 无法 100% 映射，此为 v1 已知限制。
 *
 * 宿主判定读目标进程环境变量（macOS `ps eww -p`，同用户可见）：
 *   TMUX_PANE → tmux（任何终端模拟器通用，最优先）；
 *   KITTY_WINDOW_ID + KITTY_LISTEN_ON → kitty（裸 kitty remote control）；
 *   WEZTERM_PANE → wezterm。
 *
 * 三种在场结论（驱动 attach 路由分流，语义见 inject-hub.ts）：
 *   TUI+宿主 → 注入接管；TUI 无宿主 → 不可接管（拒绝，防与真人 TUI 双写）；无 TUI → 后台驱动接管。
 */
import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";

export type AgentCmd = "claude" | "codex" | "pi";

export type TerminalHost =
  | { kind: "tmux"; pane: string }
  | { kind: "kitty"; socket: string; windowId: number }
  | { kind: "wezterm"; paneId: string };

/** 发现结果：host=null 表示 TUI 在跑但宿主无注入通道（不可接管） */
export interface HostDiscovery {
  pid: number;
  host: TerminalHost | null;
  ambiguous: boolean;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** 进程表一行（ps -axo pid=,etime=,command=；macOS 无 etimes 关键字，etime=[[dd-]hh:]mm:ss） */
export interface PsProcessRow {
  pid: number;
  /** 进程已运行秒数（etime 解析结果） */
  elapsed: number;
  command: string;
}

/** 解析 etime（[[dd-]hh:]mm:ss）→ 秒；格式不合法返回 null */
export function parseEtimesteconds(etime: string): number | null {
  let days = 0;
  let rest = etime;
  const d = /^(\d+)-(.*)$/.exec(etime);
  if (d) {
    days = Number.parseInt(d[1], 10);
    rest = d[2];
  }
  const parts = rest.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86400 + secs;
}

/** 解析 `ps -axo pid=,etime=,command=` 输出（command 可含空格，pid/etime 定宽切） */
export function parsePsProcessTable(output: string): PsProcessRow[] {
  const rows: PsProcessRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsed = parseEtimesteconds(m[2]);
    if (elapsed === null) continue;
    rows.push({ pid: Number.parseInt(m[1], 10), elapsed, command: m[3].trimEnd() });
  }
  return rows;
}

/** command 是否为「交互式 TUI」进程（排除 hub 自己的 headless 驱动/一次性 run） */
export function isInteractiveTuiCommand(command: string, agent: AgentCmd): boolean {
  const tokens = command.split(/\s+/);
  const base = (tokens[0] ?? "").split("/").pop() ?? "";
  if (base !== agent) return false;
  // headless 形态标记：claude -p/--print/--output-format；codex app-server/proto；一律排除
  const headlessMarkers = ["-p", "--print", "--output-format", "--input-format", "app-server", "proto"];
  return !tokens.some((t) => headlessMarkers.includes(t));
}

/** 解析 `lsof -a -p <pid> -d cwd -Fn` 输出 → cwd 绝对路径（n 行） */
export function parseLsofCwd(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("n")) return line.slice(1);
  }
  return null;
}

/** 解析 `ps eww -p <pid>` 尾部环境变量（KEY=VALUE 空格分隔；值含空格时不完整，目标变量均无空格） */
export function parsePsEwwEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  // 取最后一行（ps 头行 + 单进程行；命令部分可能含 =，环境变量段从命令后开始）
  const line = output.trim().split("\n").pop() ?? "";
  for (const token of line.split(/\s+/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** 宿主判定（tmux 优先：tmux 里的进程也可能带 KITTY_* 变量，但 tmux 通道更通用） */
export function hostFromEnv(env: Record<string, string>): TerminalHost | null {
  if (env.TMUX_PANE) return { kind: "tmux", pane: env.TMUX_PANE };
  if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) {
    const windowId = Number.parseInt(env.KITTY_WINDOW_ID, 10);
    if (Number.isFinite(windowId)) return { kind: "kitty", socket: env.KITTY_LISTEN_ON, windowId };
  }
  if (env.WEZTERM_PANE) return { kind: "wezterm", paneId: env.WEZTERM_PANE };
  return null;
}

/** 路径比较归一：realpath（macOS /tmp→/private/tmp 符号链接）+ 去尾斜杠 + 大小写兜底 */
function samePath(a: string, b: string): boolean {
  const resolve = (s: string): string => {
    try {
      return realpathSync(s);
    } catch {
      return s;
    }
  };
  const norm = (s: string) => resolve(s).replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function execFileAsync(execFileFn: ExecFileLike, file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * 发现会话的交互 TUI 进程与其宿主通道。
 * 返回 null = 没找到 TUI（会话不在任何窗口 → 可安全走后台驱动）；
 * host:null = 找到 TUI 但宿主无注入通道（不可接管，防双写）。
 */
export async function discoverHost(
  opts: { cwd: string; sessionId: string; agent: AgentCmd },
  execFileFn: ExecFileLike = nodeExecFile as unknown as ExecFileLike,
): Promise<HostDiscovery | null> {
  let table: PsProcessRow[];
  try {
    table = parsePsProcessTable(await execFileAsync(execFileFn, "ps", ["-axo", "pid=,etime=,command="]));
  } catch {
    return null; // ps 失败按「无 TUI」容错：不阻塞后台驱动路径
  }
  const candidates = table.filter((r) => isInteractiveTuiCommand(r.command, opts.agent));

  const matched: Array<PsProcessRow & { exact: boolean }> = [];
  for (const row of candidates.slice(0, 32)) {
    let cwd: string | null = null;
    try {
      cwd = parseLsofCwd(await execFileAsync(execFileFn, "lsof", ["-a", "-p", String(row.pid), "-d", "cwd", "-Fn"]));
    } catch {
      continue; // lsof 失败（进程刚退出等）跳过
    }
    if (!cwd || !samePath(cwd, opts.cwd)) continue;
    matched.push({ ...row, exact: row.command.split(/\s+/).includes(opts.sessionId) });
  }
  if (matched.length === 0) return null;

  // 精确命中 > 唯一 cwd 候选 > 多候选取最近启动（elapsed 最小）
  const exact = matched.find((m) => m.exact);
  const pick = exact ?? matched.reduce((a, b) => (a.elapsed <= b.elapsed ? a : b));

  let host: TerminalHost | null = null;
  try {
    const env = parsePsEwwEnv(await execFileAsync(execFileFn, "ps", ["eww", "-p", String(pick.pid)]));
    host = hostFromEnv(env);
  } catch {
    host = null;
  }
  return { pid: pick.pid, host, ambiguous: !exact && matched.length > 1 };
}
