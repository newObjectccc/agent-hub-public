/**
 * 系统探测：pi / tmux / ttyd / tailscale 可用性与版本（跨平台）+ 真实系统指标。
 * Windows 用 where，类 Unix 用 which；检测失败一律 available:false，不是错误。
 * 指标采集见 metrics.ts；单项失败降级为 null，不影响其它字段。
 */
import { execFile } from "node:child_process";
import { collectSystemMetrics } from "./metrics.js";
import type { SystemInfo, SystemMetrics, ToolAvailability, TailscaleStatus } from "./types.js";

export interface ProbeOptions {
  sessionDir: string;
  workspaceRoot: string;
  /** SDK 内置版本（PATH 无 pi 时作为 pi 可用性兜底） */
  sdkVersion?: string;
  execFileFn?: typeof execFile;
  timeoutMs?: number;
  /** 指标采集（缺省用 metrics.collectSystemMetrics；测试可注入） */
  collectMetrics?: () => Promise<SystemMetrics | null>;
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

  const collectMetrics =
    options.collectMetrics ??
    ((): Promise<SystemMetrics | null> =>
      collectSystemMetrics({ workspaceRoot: options.workspaceRoot, execFileFn, timeoutMs: 3_000 }));
  let metrics: SystemMetrics | null = null;
  try {
    metrics = await collectMetrics();
  } catch {
    metrics = null; // 指标失败不拖垮 /api/system
  }

  return {
    platform: process.platform,
    pi,
    claude,
    tmux,
    ttyd,
    tailscale,
    sessionDir: options.sessionDir,
    workspaceRoot: options.workspaceRoot,
    metrics,
  };
}

export interface SystemInfoProviderOptions extends ProbeOptions {
  /** 工具探测结果缓存时长（工具安装状态不会秒级变化；指标每次新采） */
  toolsTtlMs?: number;
}

/**
 * 带缓存的 /api/system 数据源：工具探测（一堆子进程）按 toolsTtlMs 缓存，
 * 真实指标每次重新采集（前端 5-10s 轮询看到的是新鲜数据）。
 */
export function createSystemInfoProvider(options: SystemInfoProviderOptions): () => Promise<SystemInfo> {
  const toolsTtlMs = options.toolsTtlMs ?? 30_000;
  let toolsPromise: Promise<Omit<SystemInfo, "metrics"> | null> | null = null;
  let toolsAt = 0;
  const probeTools = async (): Promise<Omit<SystemInfo, "metrics">> => {
    const { metrics: _metrics, ...tools } = await probeSystem({ ...options, collectMetrics: async () => null });
    return tools;
  };
  return async () => {
    const now = Date.now();
    if (toolsPromise === null || now - toolsAt >= toolsTtlMs) {
      toolsAt = now;
      toolsPromise = probeTools().catch(() => null);
    }
    const tools = await toolsPromise;
    if (tools === null) throw new Error("system probe failed");
    const collectMetrics =
      options.collectMetrics ??
      ((): Promise<SystemMetrics | null> =>
        collectSystemMetrics({
          workspaceRoot: options.workspaceRoot,
          execFileFn: options.execFileFn ?? execFile,
          timeoutMs: 3_000,
        }));
    let metrics: SystemMetrics | null = null;
    try {
      metrics = await collectMetrics();
    } catch {
      metrics = null;
    }
    return { ...tools, metrics };
  };
}
