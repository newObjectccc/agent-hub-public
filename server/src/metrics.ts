/**
 * 真实系统指标采集（CPU / 内存 / 磁盘 / 负载 / 运行时长），跨平台、只读、轻量。
 *
 * - CPU：两次 os.cpus() times 采样差分（os.loadavg 并存报告，见 loadavg 字段）
 * - 内存：os.totalmem / os.freemem（全跨平台）
 * - 磁盘：POSIX 解析 `df -k <workspaceRoot>`（项目所在盘）；Windows 用
 *   `wmic logicaldisk`（按 workspaceRoot 盘符过滤）；失败优雅降级 null
 * - 负载：os.loadavg()（Windows 恒 [0,0,0] → null）
 * - 运行时长：os.uptime()
 *
 * 任何单项失败只降级该项（null），绝不让 /api/system 整体挂掉。
 * 采样不阻塞事件循环：CPU 差分靠两次快照 + setTimeout 间隔，磁盘靠一次性子进程。
 */
import { execFile } from "node:child_process";
import os from "node:os";
import type { CpuMetrics, DiskMetrics, MemoryMetrics, SystemMetrics } from "./types.js";

export interface MetricsOptions {
  /** 磁盘探测的锚点路径（项目所在盘） */
  workspaceRoot: string;
  execFileFn?: typeof execFile;
  timeoutMs?: number;
  /** CPU 两次采样间隔（ms） */
  cpuSampleMs?: number;
  /** 注入 sleep 便于测试 */
  sleep?: (ms: number) => Promise<void>;
}

const KB = 1024;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, round1(value)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 不阻止进程退出（采样间隙）
    if (typeof timer.unref === "function") timer.unref();
  });
}

function run(
  execFileFn: typeof execFile,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFileFn(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve({ ok: error === null, stdout: String(stdout ?? "") });
      });
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
}

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

function timesOf(cpu: os.CpuInfo): CpuTimes {
  return {
    user: cpu.times.user,
    nice: cpu.times.nice,
    sys: cpu.times.sys,
    idle: cpu.times.idle,
    irq: cpu.times.irq,
  };
}

function totalOf(t: CpuTimes): number {
  return t.user + t.nice + t.sys + t.idle + t.irq;
}

/**
 * 两次 os.cpus() 采样差分 → CPU 使用率百分比（0..100，1 位小数）。
 * 总时间差 ≤ 0 或样本数为 0 → null（优雅降级）。
 */
export function cpuUsageFromSamples(a: os.CpuInfo[], b: os.CpuInfo[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < n; i += 1) {
    const ta = timesOf(a[i]);
    const tb = timesOf(b[i]);
    totalDelta += totalOf(tb) - totalOf(ta);
    idleDelta += tb.idle - ta.idle;
  }
  if (totalDelta <= 0) return null;
  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

/** 两次快照采样（间隔 cpuSampleMs，setTimeout 等待不阻塞事件循环） */
export async function sampleCpuUsage(cpuSampleMs = 200, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<number | null> {
  const first = os.cpus();
  if (first.length === 0) return null;
  await sleep(cpuSampleMs);
  return cpuUsageFromSamples(first, os.cpus());
}

/**
 * 解析 `df -k` 输出的数据行（macOS 9 列 / Linux 6 列均可）：
 * tokens[1..4] = 1024-blocks / Used / Available / Capacity%，mount 取行尾 token。
 */
export function parseDfOutput(output: string): DiskMetrics | null {
  for (const line of output.split("\n").slice(1)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    const blocks = Number(tokens[1]);
    const used = Number(tokens[2]);
    const avail = Number(tokens[3]);
    const capacity = Number(tokens[4].replace("%", ""));
    if (![blocks, used, avail, capacity].every(Number.isFinite)) continue;
    if (blocks <= 0) continue;
    return {
      usedBytes: used * KB,
      totalBytes: blocks * KB,
      usagePercent: clampPercent(capacity),
      mount: tokens[tokens.length - 1],
    };
  }
  return null;
}

/** 解析 wmic `logicaldisk ... /value` 输出（FreeSpace=… / Size=…），drive 为盘符标签 */
export function parseWmicDiskOutput(output: string, drive: string): DiskMetrics | null {
  const read = (key: string): number => {
    const match = new RegExp(`^${key}=(\\d+)`, "m").exec(output);
    return match ? Number(match[1]) : Number.NaN;
  };
  const size = read("Size");
  const free = read("FreeSpace");
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free) || free < 0) return null;
  const used = size - free;
  return {
    usedBytes: used,
    totalBytes: size,
    usagePercent: clampPercent((used / size) * 100),
    mount: drive,
  };
}

/** workspaceRoot → Windows 盘符（如 "C:"）；无盘符 → null */
export function windowsDriveOf(workspaceRoot: string): string | null {
  const match = /^([A-Za-z]:)/.exec(workspaceRoot);
  return match ? match[1].toUpperCase() : null;
}

/** 磁盘指标（项目所在盘）：POSIX `df -k` / Windows wmic；失败 → null */
export async function collectDiskMetrics(options: MetricsOptions): Promise<DiskMetrics | null> {
  const execFileFn = options.execFileFn ?? execFile;
  const timeoutMs = options.timeoutMs ?? 3_000;
  try {
    if (process.platform === "win32") {
      const drive = windowsDriveOf(options.workspaceRoot);
      if (drive === null) return null;
      const result = await run(
        execFileFn,
        "wmic",
        ["logicaldisk", "where", `DeviceID='${drive}'`, "get", "FreeSpace,Size", "/value"],
        timeoutMs,
      );
      if (!result.ok) return null;
      return parseWmicDiskOutput(result.stdout, drive);
    }
    // POSIX（darwin / linux）：df 直接给"包含该路径"的文件系统
    const result = await run(execFileFn, "df", ["-k", options.workspaceRoot], timeoutMs);
    if (!result.ok) return null;
    return parseDfOutput(result.stdout);
  } catch {
    return null;
  }
}

/** 内存指标（全跨平台）：used = total - free */
export function collectMemoryMetrics(): MemoryMetrics {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    usedBytes,
    totalBytes,
    usagePercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0,
  };
}

/** 负载均值：Windows 无 loadavg（恒 [0,0,0]）→ null */
export function collectLoadavg(): [number, number, number] | null {
  const [l1, l5, l15] = os.loadavg();
  if (l1 === 0 && l5 === 0 && l15 === 0) return null;
  return [l1, l5, l15];
}

/**
 * 全量指标采集：单项失败独立降级（cpu/disk → null），其余字段照常返回。
 * 调用方再兜一层 catch 保证整体永不抛出。
 */
export async function collectSystemMetrics(options: MetricsOptions): Promise<SystemMetrics> {
  const cpuSampleMs = options.cpuSampleMs ?? 200;
  const [usagePercent, disk] = await Promise.all([
    sampleCpuUsage(cpuSampleMs, options.sleep).catch(() => null),
    collectDiskMetrics(options).catch(() => null),
  ]);
  return {
    cpu: { usagePercent, cores: os.cpus().length },
    memory: collectMemoryMetrics(),
    disk,
    loadavg: collectLoadavg(),
    uptimeSeconds: os.uptime(),
    sampledAt: new Date().toISOString(),
  };
}
