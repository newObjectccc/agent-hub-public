/**
 * 真实系统指标采集单测（纯函数解析 + fake execFile 降级路径）。
 * 只测确定性逻辑；本机真实数值对比在验收环节用 curl + top/df 完成。
 */
import { strict as assert } from "node:assert";
import type { execFile as ExecFileFn } from "node:child_process";
import os from "node:os";
import { describe, it } from "node:test";
import {
  collectSystemMetrics,
  cpuUsageFromSamples,
  parseDfOutput,
  parseWmicDiskOutput,
  sampleCpuUsage,
  windowsDriveOf,
} from "../metrics.js";

function cpu(times: { user: number; nice: number; sys: number; idle: number; irq: number }): os.CpuInfo {
  return { model: "fake", speed: 2400, times } as os.CpuInfo;
}

describe("metrics: CPU 差分采样", () => {
  it("两次采样差分算出使用率百分比", () => {
    // 总增量 1000，idle 增量 250 → 使用率 75%
    const a = [cpu({ user: 1000, nice: 0, sys: 500, idle: 8000, irq: 0 })];
    const b = [cpu({ user: 1500, nice: 0, sys: 750, idle: 8250, irq: 0 })];
    assert.equal(cpuUsageFromSamples(a, b), 75);
  });

  it("多核按总时间差分聚合", () => {
    const a = [
      cpu({ user: 0, nice: 0, sys: 0, idle: 100, irq: 0 }),
      cpu({ user: 0, nice: 0, sys: 0, idle: 100, irq: 0 }),
    ];
    const b = [
      cpu({ user: 60, nice: 0, sys: 20, idle: 120, irq: 0 }), // total 200 → idle 20
      cpu({ user: 40, nice: 0, sys: 40, idle: 120, irq: 0 }), // total 200 → idle 20
    ];
    assert.equal(cpuUsageFromSamples(a, b), 80);
  });

  it("时间没有前进或空样本 → null（优雅降级）", () => {
    const t = cpu({ user: 1, nice: 1, sys: 1, idle: 1, irq: 1 });
    assert.equal(cpuUsageFromSamples([t], [t]), null);
    assert.equal(cpuUsageFromSamples([], []), null);
  });

  it("结果 clamp 到 0..100（idle 回退也不越界）", () => {
    const a = [cpu({ user: 100, nice: 0, sys: 0, idle: 100, irq: 0 })];
    const b = [cpu({ user: 100, nice: 0, sys: 0, idle: 300, irq: 0 })]; // idle 增量 > total 增量
    assert.equal(cpuUsageFromSamples(a, b), 0);
  });

  it("sampleCpuUsage 走两次快照（注入 sleep 不真的等待）", async () => {
    let slept = 0;
    const usage = await sampleCpuUsage(200, async (ms) => {
      slept += ms;
    });
    assert.equal(slept, 200);
    // 真实 os 采样：有核则差分有效（0..100），无核 → null
    if (os.cpus().length > 0 && usage !== null) {
      assert.ok(usage >= 0 && usage <= 100, `usage=${usage}`);
    }
  });
});

const DF_MACOS = `Filesystem    1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  971350180 423357968 487665860    47%  613284 4870625764    0%   /
devfs                 201       201         0   100%     695          0  100%   /dev
`;

const DF_LINUX = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1       10255676  5255676   4473716    54%   /
tmpfs             4037840        0   4037840     0%   /dev/shm
`;

describe("metrics: df / wmic 解析", () => {
  it("解析 macOS df -k（9 列）首条数据行", () => {
    const disk = parseDfOutput(DF_MACOS);
    assert.ok(disk);
    assert.equal(disk.usedBytes, 423357968 * 1024);
    assert.equal(disk.totalBytes, 971350180 * 1024);
    assert.equal(disk.usagePercent, 47);
    assert.equal(disk.mount, "/");
  });

  it("解析 Linux df -k（6 列）", () => {
    const disk = parseDfOutput(DF_LINUX);
    assert.ok(disk);
    assert.equal(disk.usagePercent, 54);
    assert.equal(disk.mount, "/");
    assert.equal(disk.usedBytes, 5255676 * 1024);
  });

  it("垃圾输出 → null（不抛错）", () => {
    assert.equal(parseDfOutput("df: /nope: No such file or directory\n"), null);
    assert.equal(parseDfOutput(""), null);
  });

  it("解析 wmic logicaldisk /value", () => {
    const disk = parseWmicDiskOutput("\r\nFreeSpace=500\r\nSize=1000\r\n\r\n", "C:");
    assert.ok(disk);
    assert.equal(disk.usedBytes, 500);
    assert.equal(disk.totalBytes, 1000);
    assert.equal(disk.usagePercent, 50);
    assert.equal(disk.mount, "C:");
  });

  it("wmic 缺字段 / 零容量 → null", () => {
    assert.equal(parseWmicDiskOutput("Size=abc", "C:"), null);
    assert.equal(parseWmicDiskOutput("FreeSpace=1", "C:"), null);
    assert.equal(parseWmicDiskOutput("FreeSpace=1\nSize=0", "C:"), null);
  });

  it("windowsDriveOf 取盘符（含反斜杠路径）", () => {
    assert.equal(windowsDriveOf("C:\\Users\\me\\ws"), "C:");
    assert.equal(windowsDriveOf("d:/ws"), "D:");
    assert.equal(windowsDriveOf("/Users/me/ws"), null);
  });
});

function fakeExecFile(stdout: string, ok = true): typeof ExecFileFn {
  const impl = ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
    cb(ok ? null : new Error("boom"), stdout);
  }) as unknown as typeof ExecFileFn;
  return impl;
}

describe("metrics: collectSystemMetrics 降级", () => {
  const base = { workspaceRoot: "/Users/me/ws", cpuSampleMs: 1, sleep: async () => undefined };

  it("磁盘解析成功 + 内存/核数/运行时长真实存在", async () => {
    const metrics = await collectSystemMetrics({ ...base, execFileFn: fakeExecFile(DF_MACOS) });
    assert.ok(metrics.disk);
    assert.equal(metrics.disk.usagePercent, 47);
    assert.ok(metrics.cpu.cores >= 1);
    assert.ok(metrics.memory.totalBytes > 0);
    assert.equal(metrics.memory.usagePercent, Math.min(100, Math.max(0, Math.round(((metrics.memory.usedBytes / metrics.memory.totalBytes) * 100) * 10) / 10)));
    assert.ok(metrics.uptimeSeconds > 0);
    assert.ok(!Number.isNaN(Date.parse(metrics.sampledAt)));
  });

  it("磁盘命令失败 → disk null，其余字段照常（/api/system 不挂）", async () => {
    const metrics = await collectSystemMetrics({ ...base, execFileFn: fakeExecFile("", false) });
    assert.equal(metrics.disk, null);
    assert.ok(metrics.memory.totalBytes > 0);
    assert.ok(metrics.cpu.cores >= 1);
  });

  it("execFile 抛异常 → disk null 不炸", async () => {
    const throwing = (() => {
      throw new Error("spawn fail");
    }) as unknown as typeof ExecFileFn;
    const metrics = await collectSystemMetrics({ ...base, execFileFn: throwing });
    assert.equal(metrics.disk, null);
    assert.ok(metrics.uptimeSeconds > 0);
  });
});
