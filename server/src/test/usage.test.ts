/**
 * Token 用量统计（docs/API_CONTRACT.md §15，pi 源）单测：
 * usage 解析（宽容：坏行/缺字段/非法值优雅跳过）、时间窗聚合（今日/近 7 天/全部/自定义 days）、
 * UsageService 增量缓存（mtime+size 未变不重读）与单会话查询。
 * 全部用构造的 JSONL fixture，不依赖本机真实数据。
 */
import { strict as assert } from "node:assert";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { collectAllSamples, daysAgoStart, emptyTotals, parseDaysParam, parseUsageSamples, sumUsage, usageFromRaw, usageRange, usageSamplesFromEntries, usageWindows, UsageService, type UsageSample } from "../usage.js";
import { startOfDay } from "../dashboard.js";
import type { RawEntry } from "../sessions/scan.js";
import { ErrorCodes, HubError } from "../errors.js";

const NOW = Date.parse("2026-02-18T12:00:00.000Z"); // 周三
const TODAY_TS = startOfDay(NOW) + 2 * 3_600_000; // 今日窗口内
const WEEK_TS = daysAgoStart(NOW, 6) + 60_000; // 近 7 天窗口内、今日外
const OLD_TS = startOfDay(NOW) - 10 * 86_400_000; // 7 天前，只计入「全部」

/** 构造一条带 usage 的 assistant 消息 JSONL 行（真实 pi 样本形状） */
function usageLine(id: string, timestampMs: number, usage: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "好" }],
      timestamp: timestampMs,
      usage,
    },
  });
}

const USAGE_A = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, totalTokens: 162, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
const USAGE_B = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 15 }; // 无 cost 字段

describe("usage: 解析（宽容，坏数据不影响整体）", () => {
  it("usageFromRaw：数值字段逐项读取，缺字段按 0，cost.total 非数值/缺失为 null", () => {
    assert.deepEqual(usageFromRaw(USAGE_A), {
      totalTokens: 162, input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, costTotal: 3,
    });
    assert.deepEqual(usageFromRaw(USAGE_B), {
      totalTokens: 15, input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 1, costTotal: null,
    });
    // 非法值（字符串/NaN）按 0，不让单条炸掉聚合
    const weird = usageFromRaw({ input: "999", output: Number.NaN, totalTokens: 5, cost: { total: "x" } });
    assert.deepEqual(weird, { totalTokens: 5, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costTotal: null });
    assert.equal(usageFromRaw("not-a-object"), null);
    assert.equal(usageFromRaw(undefined), null);
    // cost.total 允许 0（区别于 null：0 是有效金额）
    assert.equal(usageFromRaw({ totalTokens: 1, cost: { total: 0 } })?.costTotal, 0);
  });

  it("parseUsageSamples：坏行 / 缺 usage / 非 message entry 优雅跳过", () => {
    const content = [
      JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-02-18T08:00:00.000Z", cwd: "/tmp/demo" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: new Date(TODAY_TS).toISOString(), message: { role: "user", content: "你好" } }),
      usageLine("a1", TODAY_TS, USAGE_A),
      "{ 这行是坏的 json",
      JSON.stringify({ type: "message", id: "a2", timestamp: new Date(WEEK_TS).toISOString(), message: { role: "assistant", content: [], usage: USAGE_B } }),
      JSON.stringify({ type: "tool_result", id: "t1" }),
    ].join("\n");
    const samples = parseUsageSamples(content);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].timestampMs, TODAY_TS);
    assert.equal(samples[0].totalTokens, 162);
    assert.equal(samples[0].costTotal, 3);
    assert.equal(samples[1].timestampMs, WEEK_TS);
    assert.equal(samples[1].costTotal, null);
  });

  it("parseUsageSamples：空文本 / 全坏行 → 空列表", () => {
    assert.deepEqual(parseUsageSamples(""), []);
    assert.deepEqual(parseUsageSamples("not json\n{\"type\":\"message\"}\n"), []);
  });

  it("usageSamplesFromEntries：message.usage 缺失跳过、时间戳缺失记 0", () => {
    const entries: RawEntry[] = [
      { type: "message", id: "m1", message: { role: "assistant", usage: { totalTokens: 9 } } },
      { type: "message", id: "m2", message: { role: "assistant" } },
      { type: "compaction", id: "c1" },
    ];
    const samples = usageSamplesFromEntries(entries);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].timestampMs, 0);
    assert.equal(samples[0].totalTokens, 9);
  });
});

describe("usage: 时间窗聚合（纯函数）", () => {
  const samples = parseUsageSamples(
    [
      usageLine("t", TODAY_TS, USAGE_A), // 今日 162
      usageLine("w", WEEK_TS, USAGE_B), // 近 7 天 15
      usageLine("o", OLD_TS, USAGE_B), // 仅全部 15
    ].join("\n"),
  );

  it("sumUsage：时间窗外不计，timestampMs=0 只计入全部", () => {
    assert.equal(sumUsage(samples).totalTokens, 192);
    assert.equal(sumUsage(samples, { sinceMs: startOfDay(NOW) }).totalTokens, 162);
    assert.equal(sumUsage(samples, { sinceMs: daysAgoStart(NOW, 6) }).totalTokens, 177);
    const unknown = usageSamplesFromEntries([{ type: "message", id: "u", message: { role: "assistant", usage: USAGE_B } }]);
    assert.equal(unknown[0].timestampMs, 0);
    assert.equal(sumUsage(unknown, { sinceMs: startOfDay(NOW) }).totalTokens, 0);
    assert.equal(sumUsage(unknown).totalTokens, 15);
  });

  it("sumUsage：cost.total 全程缺失 → null；出现过则缺失项按 0 累加", () => {
    const costLess = parseUsageSamples(usageLine("x", TODAY_TS, USAGE_B));
    assert.equal(sumUsage(costLess).costTotal, null);
    assert.equal(sumUsage(samples).costTotal, 3); // 只有 t 这条带 cost
  });

  it("usageWindows：today / last7Days / all 三窗口同源求和", () => {
    const w = usageWindows(samples, NOW);
    assert.deepEqual(
      { today: w.today.totalTokens, last7Days: w.last7Days.totalTokens, all: w.all.totalTokens },
      { today: 162, last7Days: 177, all: 192 },
    );
    assert.deepEqual(
      { today: w.today.input, last7Days: w.last7Days.input, all: w.all.input },
      { today: 100, last7Days: 110, all: 120 },
    );
    assert.equal(w.today.costTotal, 3);
    assert.equal(w.all.reasoning, 9);
  });

  it("usageRange：?days=N 自定义窗（最近 N 天含今日）", () => {
    assert.equal(usageRange(samples, NOW, 1).usage.totalTokens, 162);
    assert.equal(usageRange(samples, NOW, 7).usage.totalTokens, 177);
    assert.equal(usageRange(samples, NOW, 30).usage.totalTokens, 192);
  });
});

describe("usage: ?days= 参数解析", () => {
  it("缺省 undefined；合法整数 1..3650 透传；非法值 INVALID_REQUEST", () => {
    assert.equal(parseDaysParam(undefined), undefined);
    assert.equal(parseDaysParam(null), undefined);
    assert.equal(parseDaysParam("7"), 7);
    assert.equal(parseDaysParam(30), 30);
    for (const bad of ["", "abc", "1.5", "-1", "0", "3651", {}]) {
      assert.throws(
        () => parseDaysParam(bad),
        (err: unknown) => err instanceof HubError && err.code === ErrorCodes.INVALID_REQUEST,
        JSON.stringify(bad),
      );
    }
  });
});

describe("usage: UsageService（临时会话目录 + 增量缓存）", () => {
  let dir: string;
  const reads: string[] = [];
  let service: UsageService;

  const fileA = "2026-02-18T08-00-00-000Z_sess-usage-1.jsonl";
  const fileB = "--tmp-demo--/2026-02-10T08-00-00-000Z_sess-usage-2.jsonl";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-usage-"));
    // 会话 1：今日 + 近 7 天各一条
    await writeFile(join(dir, fileA), [
      JSON.stringify({ type: "session", id: "sess-usage-1", timestamp: "2026-02-18T08:00:00.000Z", cwd: "/tmp/demo" }),
      JSON.stringify({ type: "session_info", name: "用量演示" }),
      usageLine("a1", TODAY_TS, USAGE_A),
      usageLine("a2", WEEK_TS, USAGE_B),
    ].join("\n"));
    // 会话 2（子目录布局）：只有一条旧采样
    await mkdir(join(dir, "--tmp-demo--"), { recursive: true });
    await writeFile(join(dir, fileB), [
      JSON.stringify({ type: "session", id: "sess-usage-2", timestamp: "2026-02-10T08:00:00.000Z", cwd: "/tmp/demo" }),
      usageLine("b1", OLD_TS, USAGE_B),
    ].join("\n"));
    // 坏文件：只读乱码，不应影响其它会话
    await writeFile(join(dir, "broken.jsonl"), "\u0000\u0000 not json at all");
    service = new UsageService({
      sessionDir: dir,
      ttlMs: 60_000,
      minRescanMs: 0, // 测试时间尺度：invalidate 后立即对账（防风暴限速单独用例验证）
      readFile: async (file) => {
        reads.push(file);
        return readFile(file, "utf8");
      },
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("overview：三窗口聚合 + 会话明细（updatedAt 倒序，无采样会话不入列）", async () => {
    const out = await service.overview(NOW);
    assert.deepEqual(Object.keys(out).sort(), ["sessions", "windows"]);
    assert.deepEqual(Object.keys(out.windows).sort(), ["all", "last7Days", "today"]);
    assert.deepEqual(
      { today: out.windows.today.totalTokens, last7Days: out.windows.last7Days.totalTokens, all: out.windows.all.totalTokens },
      { today: 162, last7Days: 177, all: 192 },
    );
    assert.equal(out.sessions.length, 2, "坏文件/无采样会话不入列");
    const first = out.sessions[0];
    assert.equal(first.sessionId, "sess-usage-1", "updatedAt 倒序：会话 1 更新更近");
    assert.equal(first.name, "用量演示");
    assert.equal(first.usage.totalTokens, 177);
    assert.equal(out.sessions[1].sessionId, "sess-usage-2");
    assert.equal(out.sessions[1].usage.totalTokens, 15);
    assert.equal(out.sessions[1].usage.costTotal, null);
  });

  it("overview：?days= 返回 range 窗口", async () => {
    const out = await service.overview(NOW, { days: 7 });
    assert.equal(out.range?.days, 7);
    assert.equal(out.range?.usage.totalTokens, 177); // 今日 162 + 近 7 天 15
  });

  it("TTL 内不重读磁盘（不全量重读 JSONL）", async () => {
    const before = reads.length;
    await service.overview(NOW);
    await service.overview(NOW);
    assert.equal(reads.length, before, "缓存命中零读盘");
  });

  it("增量对账：只重读变更文件（mtime/size 变化）", async () => {
    await appendFile(join(dir, fileA), `\n${usageLine("a3", TODAY_TS, USAGE_B)}`);
    service.invalidate();
    const readsBefore = reads.length;
    const out = await service.overview(NOW);
    assert.equal(reads.length - readsBefore, 1, "只重读变更的 fileA");
    assert.ok(reads[reads.length - 1].endsWith(fileA));
    assert.equal(out.windows.today.totalTokens, 177);
    assert.equal(out.sessions.find((s) => s.sessionId === "sess-usage-1")?.usage.totalTokens, 192);
  });

  it("防风暴：minRescanMs 窗口内 invalidate 不触发重扫（脏标保留，窗口后补扫）", async () => {
    const throttledReads: string[] = [];
    const throttled = new UsageService({
      sessionDir: dir,
      ttlMs: 60_000,
      minRescanMs: 60_000,
      readFile: async (file) => {
        throttledReads.push(file);
        return readFile(file, "utf8");
      },
    });
    await throttled.overview(NOW); // 首扫（lastScanAt=0 不受 minRescan 限制）
    const before = throttledReads.length;
    await appendFile(join(dir, fileB), `\n${usageLine("b2", OLD_TS, USAGE_B)}`);
    throttled.invalidate();
    await throttled.overview(NOW);
    throttled.invalidate();
    await throttled.overview(NOW);
    assert.equal(throttledReads.length, before, "minRescan 窗口内 invalidate 风暴零重读");
  });

  it("session：单会话汇总（found / 不存在 → null）", async () => {
    const detail = await service.session("sess-usage-2", NOW, { days: 30 });
    assert.ok(detail);
    assert.equal(detail.sessionId, "sess-usage-2");
    assert.equal(detail.name, null);
    assert.deepEqual(Object.keys(detail).sort(), ["name", "range", "sessionId", "updatedAt", "windows"]);
    assert.equal(detail.windows.all.totalTokens, 15);
    assert.equal(detail.range?.usage.totalTokens, 15);
    assert.equal(await service.session("nope", NOW), null);
  });

  it("AC10：请求侧限时——冷启动超时先回空窗，后台完成后最终一致（无反复跳变）", async () => {
    const slow = new UsageService({
      sessionDir: dir,
      ttlMs: 60_000,
      minRescanMs: 0,
      refreshWaitMs: 100,
      readFile: async (file) => {
        await new Promise((r) => setTimeout(r, 400)); // 模拟冷启动慢扫描
        return readFile(file, "utf8");
      },
    });
    const t0 = Date.now();
    const out = await slow.overview(NOW);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 350, `请求侧限时 100ms，不同步等全量扫描（实测 ${elapsed}ms）`);
    assert.equal(out.sessions.length, 0, "超时先回空窗（UI 走无数据占位降级）");
    // 后台扫描继续 → 下一次查询即拿到全量（最终一致）
    let settled = await slow.overview(NOW);
    for (let i = 0; i < 20 && settled.sessions.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      settled = await slow.overview(NOW);
    }
    assert.equal(settled.sessions.length, 2, "后台扫描完成后最终一致");
    assert.ok(settled.windows.all.totalTokens > 0);
  });

  it("AC10：冷启动 session 查询不误报 404（限时后等扫完返回数据）", async () => {
    const slow = new UsageService({
      sessionDir: dir,
      ttlMs: 60_000,
      minRescanMs: 0,
      refreshWaitMs: 50,
      readFile: async (file) => {
        await new Promise((r) => setTimeout(r, 300));
        return readFile(file, "utf8");
      },
    });
    const detail = await slow.session("sess-usage-1", NOW);
    assert.ok(detail, "冷启动空窗不误报 404：等后台扫完返回数据");
    assert.equal(detail.sessionId, "sess-usage-1");
  });

  it("AC10：warmup 启动预热 fire-and-forget（不阻塞、预扫先行）", async () => {
    const preReads: string[] = [];
    const pre = new UsageService({
      sessionDir: dir,
      ttlMs: 60_000,
      minRescanMs: 0,
      readFile: async (file) => {
        preReads.push(file);
        return readFile(file, "utf8");
      },
    });
    pre.warmup(); // 不 await：fire-and-forget
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(preReads.length >= 1, "预热已开始预扫");
    const out = await pre.overview(NOW);
    assert.equal(out.sessions.length, 2, "预热完成后 overview 直接命中缓存");
  });
});

describe("usage: 大数组汇总（OOM 审计 AC7）", () => {
  it("collectAllSamples：单会话 >6 万采样循环追加不栈溢出（禁 spread）", () => {
    const sample: UsageSample = { timestampMs: 1, ...emptyTotals() };
    const entries = [
      { samples: Array.from({ length: 200_000 }, () => sample) },
      { samples: Array.from({ length: 200_000 }, () => sample) },
    ];
    const out = collectAllSamples(entries);
    assert.equal(out.length, 400_000, "40 万采样全部汇总（spread 实现会 RangeError）");
  });
});
