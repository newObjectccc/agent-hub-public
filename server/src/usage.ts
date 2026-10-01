/**
 * pi 会话 Token 用量统计（docs/API_CONTRACT.md §15，pi 源专用，claude 源延后）。
 *
 * 事实源是 ~/.pi/agent/sessions/ 下的 JSONL：每条 assistant 消息 entry 的
 * `message.usage` 记录一次 API 调用的用量（input/output/cacheRead/cacheWrite/
 * reasoning/totalTokens/cost.total），聚合即逐条求和。坏行 / 缺 usage 字段优雅跳过，
 * 单条失败不影响整体（与 sessions/scan.ts 同口径）。
 *
 * 纯函数（usageFromRaw / usageSamplesFromEntries / sumUsage / usageWindows / parseDaysParam）
 * 与 IO（UsageService：按文件 mtime+size 增量重读 + TTL 缓存，不全量重读 JSONL）分层，便于单测。
 */
import { stat } from "node:fs/promises";
import { startOfDay } from "./dashboard.js";
import { ErrorCodes, HubError } from "./errors.js";
import { findSessionFiles, parseSessionJsonl, readSessionFile, sessionName, type RawEntry } from "./sessions/scan.js";
import type {
  SessionUsageDto,
  UsageOverviewDto,
  UsageRangeDto,
  UsageSessionDto,
  UsageTotalsDto,
  UsageWindowsDto,
} from "./types.js";

/** 单次 API 调用的 usage 采样（timestampMs=0 表示时间未知，只计入「全部」窗口） */
export interface UsageSample extends UsageTotalsDto {
  timestampMs: number;
}

export function emptyTotals(): UsageTotalsDto {
  return { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costTotal: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numField(source: Record<string, unknown>, key: string): number {
  const v = source[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * `message.usage` 原始对象 → 汇总维度（宽容解析）：
 * 非对象返回 null；缺失/非数值字段按 0；cost.total 仅在为数值时计入（否则 null）。
 */
export function usageFromRaw(raw: unknown): UsageTotalsDto | null {
  if (!isRecord(raw)) return null;
  let costTotal: number | null = null;
  if (isRecord(raw.cost) && typeof raw.cost.total === "number" && Number.isFinite(raw.cost.total)) {
    costTotal = raw.cost.total;
  }
  return {
    totalTokens: numField(raw, "totalTokens"),
    input: numField(raw, "input"),
    output: numField(raw, "output"),
    cacheRead: numField(raw, "cacheRead"),
    cacheWrite: numField(raw, "cacheWrite"),
    reasoning: numField(raw, "reasoning"),
    costTotal,
  };
}

/** entry 时间戳：message.timestamp（毫秒数）优先，其次 entry.timestamp（ISO 字符串或毫秒数） */
function sampleTimestampMs(entry: RawEntry): number {
  const message = entry.message;
  if (isRecord(message) && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  const t = entry.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const parsed = Date.parse(t);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * 单条 entry → usage 采样：只要 entry.message.usage 是对象就算一次 API 调用
 * （正常仅 assistant 消息带 usage；宽容处理不因 role 差异漏计），无 usage 返回 null。
 */
export function sampleFromEntry(entry: RawEntry): UsageSample | null {
  if (entry.type !== "message") return null;
  const message = entry.message;
  if (!isRecord(message)) return null;
  const totals = usageFromRaw(message.usage);
  if (totals === null) return null;
  return { timestampMs: sampleTimestampMs(entry), ...totals };
}

/** entries → 采样列表（坏 entry 优雅跳过） */
export function usageSamplesFromEntries(entries: RawEntry[]): UsageSample[] {
  const out: UsageSample[] = [];
  for (const entry of entries) {
    const sample = sampleFromEntry(entry);
    if (sample !== null) out.push(sample);
  }
  return out;
}

/** JSONL 文本 → 采样列表（坏行跳过；单测直接喂 fixture 文本） */
export function parseUsageSamples(content: string): UsageSample[] {
  return usageSamplesFromEntries(parseSessionJsonl(content).entries);
}

export interface UsageWindow {
  sinceMs?: number;
  untilMs?: number;
}

/**
 * 采样求和（纯函数）。时间窗 [sinceMs, untilMs)：
 * timestampMs=0（时间未知）只计入无 sinceMs 的「全部」窗口。
 * cost.total 全程未出现（或全为 null）时汇总为 null，出现过则按 0 计缺失项。
 */
export function sumUsage(samples: Iterable<UsageSample>, window: UsageWindow = {}): UsageTotalsDto {
  const totals = emptyTotals();
  let sawCost = false;
  for (const s of samples) {
    if (window.sinceMs !== undefined && s.timestampMs < window.sinceMs) continue;
    if (window.untilMs !== undefined && s.timestampMs >= window.untilMs) continue;
    totals.totalTokens += s.totalTokens;
    totals.input += s.input;
    totals.output += s.output;
    totals.cacheRead += s.cacheRead;
    totals.cacheWrite += s.cacheWrite;
    totals.reasoning += s.reasoning;
    if (s.costTotal !== null) {
      sawCost = true;
      totals.costTotal = (totals.costTotal ?? 0) + s.costTotal;
    }
  }
  if (!sawCost) totals.costTotal = null;
  return totals;
}

/** 前 n 天（含今日）的本地 0 点：today=前 0 天，last7Days=前 6 天（7 个自然日） */
export function daysAgoStart(now: number, days: number): number {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/** 时间窗汇总（纯函数）：今日 / 近 7 天（含今日）/ 全部 */
export function usageWindows(samples: Iterable<UsageSample>, now: number): UsageWindowsDto {
  const all = [...samples];
  return {
    today: sumUsage(all, { sinceMs: startOfDay(now) }),
    last7Days: sumUsage(all, { sinceMs: daysAgoStart(now, 6) }),
    all: sumUsage(all),
  };
}

/** 自定义时间窗汇总（?days=N，最近 N 天含今日） */
export function usageRange(samples: Iterable<UsageSample>, now: number, days: number): UsageRangeDto {
  return { days, usage: sumUsage(samples, { sinceMs: daysAgoStart(now, days - 1) }) };
}

/** ?days= 参数解析：缺省 undefined；必须为 1..3650 的整数，否则 INVALID_REQUEST */
export function parseDaysParam(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "days 必须是 1..3650 的整数");
  }
  const days = Number.parseInt(text, 10);
  if (days < 1 || days > 3650) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "days 必须是 1..3650 的整数");
  }
  return days;
}

// ---------- 服务编排（IO + 增量缓存） ----------

/** 路由层依赖接口（测试可注入 fake） */
export interface UsageServiceLike {
  /** 全局汇总：时间窗 + 会话明细（仅含有 usage 采样的会话，updatedAt 倒序） */
  overview(now: number, opts?: { days?: number }): Promise<UsageOverviewDto>;
  /** 单会话汇总；会话不存在返回 null（路由层转 SESSION_NOT_FOUND） */
  session(id: string, now: number, opts?: { days?: number }): Promise<UsageSessionDto | null>;
  /** 文件变更（presence）时标记过期：下次查询全量对账（增量：mtime+size 未变不重读） */
  invalidate(): void;
}

export interface UsageServiceOptions {
  sessionDir: string;
  /** 注入读文件（单测计数读盘次数）；缺省 readSessionFile */
  readFile?: (file: string) => Promise<string>;
  /** 缓存 TTL（默认 30s，与 dashboard 洞察缓存同量级） */
  ttlMs?: number;
  /** 最小重扫间隔（默认 5s，防 presence 高频 invalidate 风暴式全量扫描） */
  minRescanMs?: number;
}

interface FileUsageEntry {
  mtimeMs: number;
  size: number;
  sessionId: string | null;
  name: string | null;
  /** 会话最后更新时间（采样时间与文件 mtime 取新） */
  updatedAtMs: number;
  samples: UsageSample[];
}

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_MIN_RESCAN_MS = 5_000;
const SCAN_CONCURRENCY = 4;

export class UsageService implements UsageServiceLike {
  private readonly options: UsageServiceOptions;
  private readonly readFile: (file: string) => Promise<string>;
  /** 每文件用量快照：mtime+size 未变的文件不重读（增量对账） */
  private readonly cache = new Map<string, FileUsageEntry>();
  private lastScanAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(options: UsageServiceOptions) {
    this.options = options;
    this.readFile = options.readFile ?? readSessionFile;
  }

  invalidate(): void {
    this.lastScanAt = 0;
  }

  private now(): number {
    return Date.now();
  }

  /** TTL 内直接用缓存；过期则对账一次（增量：只重读变更文件） */
  private async ensureFresh(): Promise<void> {
    const ttlMs = this.options.ttlMs ?? USAGE_CACHE_TTL_MS;
    const now = this.now();
    if (this.lastScanAt > 0 && now - this.lastScanAt < ttlMs) return;
    if (this.refreshing !== null) return this.refreshing;
    // 最小重扫间隔：invalidate 高频触发时拒绝风暴式对账
    if (this.lastScanAt > 0 && now - this.lastScanAt < (this.options.minRescanMs ?? USAGE_MIN_RESCAN_MS)) return;
    const task = this.refresh(now);
    this.refreshing = task;
    try {
      await task;
    } finally {
      this.refreshing = null;
    }
  }

  private async refresh(now: number): Promise<void> {
    const files = await findSessionFiles(this.options.sessionDir);
    const seen = new Set(files);
    for (const known of [...this.cache.keys()]) {
      if (!seen.has(known)) this.cache.delete(known); // 文件删除：清账
    }
    const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
    for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
      await yieldLoop(); // 批间让出：扫描不独占事件循环
      await Promise.all(
        files.slice(i, i + SCAN_CONCURRENCY).map(async (file) => {
          try {
            const fileStat = await stat(file);
            const cached = this.cache.get(file);
            if (cached !== undefined && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
              return; // 未变更：跳过读盘
            }
            const parsed = parseSessionJsonl(await this.readFile(file));
            const entries = parsed.entries;
            const samples = usageSamplesFromEntries(entries);
            // 会话最后更新时间：最后一条采样时间优先，全部缺失回退文件 mtime（与 scan.ts 同口径）
            let updatedAtMs = 0;
            for (const s of samples) {
              if (s.timestampMs > updatedAtMs) updatedAtMs = s.timestampMs;
            }
            if (updatedAtMs === 0) updatedAtMs = fileStat.mtimeMs;
            this.cache.set(file, {
              mtimeMs: fileStat.mtimeMs,
              size: fileStat.size,
              sessionId: parsed.header && typeof parsed.header.id === "string" && parsed.header.id !== "" ? parsed.header.id : null,
              name: sessionName(entries),
              updatedAtMs,
              samples,
            });
          } catch {
            // 单文件损坏不影响整体：保留旧快照（若有）
          }
        }),
      );
    }
    this.lastScanAt = now;
  }

  /** 全部会话快照（updatedAt 倒序 + sessionId 确定性 tiebreaker） */
  private snapshots(): FileUsageEntry[] {
    const out = [...this.cache.values()].filter((e) => e.sessionId !== null);
    out.sort((a, b) => {
      const d = b.updatedAtMs - a.updatedAtMs;
      if (d !== 0) return d;
      return (a.sessionId ?? "") < (b.sessionId ?? "") ? -1 : 1;
    });
    return out;
  }

  private toDto(entry: FileUsageEntry): SessionUsageDto {
    return {
      sessionId: entry.sessionId ?? "",
      name: entry.name,
      updatedAt: new Date(entry.updatedAtMs).toISOString(),
      usage: sumUsage(entry.samples),
    };
  }

  async overview(now: number, opts: { days?: number } = {}): Promise<UsageOverviewDto> {
    await this.ensureFresh();
    const snapshots = this.snapshots();
    const allSamples: UsageSample[] = [];
    const sessions: SessionUsageDto[] = [];
    for (const entry of snapshots) {
      allSamples.push(...entry.samples);
      if (entry.samples.length > 0) sessions.push(this.toDto(entry));
    }
    const dto: UsageOverviewDto = { windows: usageWindows(allSamples, now), sessions };
    if (opts.days !== undefined) dto.range = usageRange(allSamples, now, opts.days);
    return dto;
  }

  async session(id: string, now: number, opts: { days?: number } = {}): Promise<UsageSessionDto | null> {
    await this.ensureFresh();
    const entry = this.snapshots().find((e) => e.sessionId === id);
    if (entry === undefined) return null;
    const summary = this.toDto(entry);
    const dto: UsageSessionDto = {
      sessionId: summary.sessionId,
      name: summary.name,
      updatedAt: summary.updatedAt,
      windows: usageWindows(entry.samples, now),
    };
    if (opts.days !== undefined) dto.range = usageRange(entry.samples, now, opts.days);
    return dto;
  }
}
