/**
 * /api/system 数据源缓存（OOM 审计 AC9）：
 * 指标采集（sampleCpuUsage 双快照 sleep 200ms）按 30s 缓存——窗口内复用、在途去重，
 * 首次照常采集；不再每请求 200ms。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { execFile as ExecFile } from "node:child_process";
import type { SystemMetrics } from "../types.js";
import { createSystemInfoProvider } from "../system.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeMetrics: SystemMetrics = {
  cpu: { usagePercent: 12.3, cores: 8 },
  memory: { usedBytes: 1, totalBytes: 2, usagePercent: 50 },
  disk: null,
  loadavg: [1, 1, 1],
  uptimeSeconds: 42,
  sampledAt: "2026-02-18T12:00:00.000Z",
};

/** 工具探测一律「找不到」的假 execFile（不跑真实子进程） */
const fakeExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
  cb(new Error("not found"), "");
}) as unknown as typeof ExecFile;

describe("system: 指标 30s 缓存（AC9）", () => {
  it("窗口内复用指标（不再每请求采样），TTL 过期后重新采集", async () => {
    let samples = 0;
    const provider = createSystemInfoProvider({
      sessionDir: "/tmp/sessions",
      workspaceRoot: "/tmp/ws",
      execFileFn: fakeExec,
      toolsTtlMs: 60_000,
      metricsTtlMs: 300,
      collectMetrics: async () => {
        samples += 1;
        return fakeMetrics;
      },
    });
    const a = await provider();
    const b = await provider();
    assert.equal(samples, 1, "缓存窗口内指标零采样（首采照常）");
    assert.equal(a.metrics?.cpu.usagePercent, 12.3);
    assert.deepEqual(b.metrics, a.metrics);
    await sleep(350);
    const c = await provider();
    assert.equal(samples, 2, "TTL 过期后重新采集（新鲜度 30s 可接受）");
    assert.equal(c.metrics?.cpu.usagePercent, 12.3);
  });

  it("在途去重：首采进行中的并发请求共享同一次采集", async () => {
    let samples = 0;
    const provider = createSystemInfoProvider({
      sessionDir: "/tmp/sessions",
      workspaceRoot: "/tmp/ws",
      execFileFn: fakeExec,
      toolsTtlMs: 60_000,
      collectMetrics: async () => {
        samples += 1;
        await sleep(120);
        return fakeMetrics;
      },
    });
    const [a, b] = await Promise.all([provider(), provider()]);
    assert.equal(samples, 1, "并发请求不重复采样（双快照 200ms 只发生一次）");
    assert.deepEqual(a.metrics, b.metrics);
  });
});

describe("system: 工具探测 SWR（过期不阻塞请求）", () => {
  it("TTL 过期立即返回陈旧值（不等冷探测），后台刷新随后完成", async () => {
    let probes = 0;
    const slowExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      probes += 1;
      setTimeout(() => cb(new Error("not found"), ""), 120);
    }) as unknown as typeof ExecFile;
    const provider = createSystemInfoProvider({
      sessionDir: "/tmp/sessions",
      workspaceRoot: "/tmp/ws",
      execFileFn: slowExec,
      toolsTtlMs: 50,
      metricsTtlMs: 60_000,
      // 指标与本用例无关：注入假采集器（真实采集器配假 execFile 不是本测试的被测面）
      collectMetrics: async () => fakeMetrics,
    });
    await provider(); // 首次：无陈旧值，必须等真实探测
    const afterFirst = probes;
    await sleep(80); // 过期
    const t0 = Date.now();
    await provider(); // SWR：应秒回旧值（CLI 冷探测不阻塞请求）
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `过期请求应秒回（不等冷探测），实测 ${elapsed}ms`);
    await sleep(250); // 等后台刷新
    assert.ok(probes > afterFirst, "过期后后台已发生刷新探测");
    await provider();
  });
});
