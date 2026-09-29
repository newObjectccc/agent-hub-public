/**
 * 系统探测：pi / tmux / ttyd / tailscale 可用性与版本（跨平台）。
 * Windows 用 where，类 Unix 用 which；检测失败一律 available:false，不是错误。
 */
import { execFile } from "node:child_process";
import type { SystemInfo, ToolAvailability, TailscaleStatus } from "./types.js";

export interface ProbeOptions {
  sessionDir: string;
  workspaceRoot: string;
  /** SDK 内置版本（PATH 无 pi 时作为 pi 可用性兜底） */
  sdkVersion?: string;
  execFileFn?: typeof execFile;
  timeoutMs?: number;
}

function run(
  execFileFn: typeof execFile,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFileFn(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
    }
  });
}

/** 从版本输出中提取首个版本号（如 3.4 / 0.87.1 / 1.76.0） */
export function extractVersion(output: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output);
  return match ? match[1] : null;
}

const NOT_AVAILABLE: ToolAvailability = { available: false, version: null };

async function probeTool(
  execFileFn: typeof execFile,
  bin: string,
  versionArgs: string[],
  timeoutMs: number,
): Promise<ToolAvailability> {
  const isWindows = process.platform === "win32";
  const finder = isWindows ? "where" : "which";
  const located = await run(execFileFn, finder, [bin], timeoutMs);
  if (!located.ok) return { ...NOT_AVAILABLE };
  const version = await run(execFileFn, bin, versionArgs, timeoutMs);
  if (!version.ok) {
    // 找得到但跑不起来：仍视为可用（版本未知）
    return { available: true, version: null };
  }
  return { available: true, version: extractVersion(version.stdout || version.stderr) };
}

async function probeTailscale(execFileFn: typeof execFile, timeoutMs: number): Promise<TailscaleStatus> {
  // 候选链：PATH 的 tailscale（可能是损坏的 bundle wrapper，输出 Fatal error 文本）
  // → macOS App 内二进制（GUI 版自带，总是可执行）
  const candidates = ["tailscale"];
  if (process.platform === "darwin") {
    candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  }

  for (const bin of candidates) {
    const version = await run(execFileFn, bin, ["version"], timeoutMs);
    if (!version.ok) continue;
    const versionText = version.stdout.trim().split("\n")[0] ?? "";
    // 坏 wrapper 的标志：版本输出含 crash 文本或为空
    if (versionText === "" || /fatal error|panic|bundleidentifier/i.test(versionText)) continue;

    const status = await run(execFileFn, bin, ["status", "--json"], timeoutMs);
    let loggedIn = false;
    let hostname: string | null = null;
    if (status.ok) {
      try {
        const parsed = JSON.parse(status.stdout) as {
          BackendState?: string;
          Self?: { HostName?: string; DNSName?: string };
        };
        loggedIn = parsed.BackendState === "Running";
        hostname = typeof parsed.Self?.HostName === "string" ? parsed.Self.HostName : null;
      } catch {
        // status 解析失败不影响可用性
      }
    }
    return {
      available: true,
      version: /^v?\d/.test(versionText) ? versionText : null,
      loggedIn,
      hostname,
    };
  }
  return { available: false, version: null, loggedIn: false, hostname: null };
}

export async function probeSystem(options: ProbeOptions): Promise<SystemInfo> {
  const execFileFn = options.execFileFn ?? execFile;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [tmux, ttyd, tailscale, piBin, claude] = await Promise.all([
    probeTool(execFileFn, "tmux", ["-V"], timeoutMs),
    probeTool(execFileFn, "ttyd", ["--version"], timeoutMs),
    probeTailscale(execFileFn, timeoutMs),
    probeTool(execFileFn, "pi", ["--version"], timeoutMs),
    // Claude Code 会话来源可用性（claude --version）
    probeTool(execFileFn, "claude", ["--version"], timeoutMs),
  ]);

  // PATH 找不到 pi 但 SDK 已加载 → 核心能力可用（in-process 驱动）
  const pi: ToolAvailability = piBin.available
    ? piBin
    : options.sdkVersion
      ? { available: true, version: options.sdkVersion }
      : { ...NOT_AVAILABLE };

  return {
    platform: process.platform,
    pi,
    claude,
    tmux,
    ttyd,
    tailscale,
    sessionDir: options.sessionDir,
    workspaceRoot: options.workspaceRoot,
  };
}
