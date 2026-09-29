/**
 * KPI 聚合：读 config/kpi-sources.json（用户可编辑），支持
 * - http-json：fetch + jsonPath 简单路径解析（$.data.value）
 * - static：静态值
 * header 值支持 ${ENV_VAR} 环境变量引用（密钥不写文件、不进日志）。
 * 每 kpiRefreshMinutes（默认 5）分钟后台刷新缓存；单卡片失败只写 error 字段。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KpiCard } from "./types.js";

export interface KpiSourceConfig {
  id: string;
  title: string;
  type: "http-json" | "static" | string;
  url?: string;
  headers?: Record<string, unknown>;
  jsonPath?: string;
  unit?: string;
  link?: string;
  value?: unknown;
  trend?: unknown;
  delta?: unknown;
}

export interface KpiSourcesFile {
  sources: KpiSourceConfig[];
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${ENV_VAR}` → 环境变量值；未设置解析为空字符串（不落密钥到文件/日志） */
export function resolveEnvRefs(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(ENV_REF, (_match, name: string) => env[name] ?? "");
}

export function resolveHeaders(headers: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = resolveEnvRefs(value, env);
    else if (value !== undefined && value !== null) result[key] = String(value);
  }
  return result;
}

/**
 * jsonPath 简单路径解析：`$.a.b`、`$['a'].b`、`$[0].b`、`$.a.0.b`。
 * 路径非法抛错；路径不存在返回 undefined。
 */
export function parseJsonPath(path: string): (data: unknown) => unknown {
  const trimmed = path.trim();
  if (!trimmed.startsWith("$")) {
    throw new Error(`jsonPath 必须以 $ 开头: ${path}`);
  }
  type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };
  const segments: Segment[] = [];
  let rest = trimmed.slice(1);
  const keyRe = /^\.([A-Za-z_][A-Za-z0-9_]*)/;
  const bracketKeyRe = /^\[\s*'([^']*)'\s*\]|^\[\s*"([^"]*)"\s*\]/;
  const bracketIndexRe = /^\[\s*(-?\d+)\s*\]/;
  while (rest !== "") {
    const keyMatch = keyRe.exec(rest);
    if (keyMatch) {
      segments.push({ kind: "key", key: keyMatch[1] });
      rest = rest.slice(keyMatch[0].length);
      continue;
    }
    const bracketKeyMatch = bracketKeyRe.exec(rest);
    if (bracketKeyMatch) {
      segments.push({ kind: "key", key: bracketKeyMatch[1] ?? bracketKeyMatch[2] ?? "" });
      rest = rest.slice(bracketKeyMatch[0].length);
      continue;
    }
    const bracketIndexMatch = bracketIndexRe.exec(rest);
    if (bracketIndexMatch) {
      segments.push({ kind: "index", index: Number(bracketIndexMatch[1]) });
      rest = rest.slice(bracketIndexMatch[0].length);
      continue;
    }
    if (/^\.(-?\d+)/.test(rest)) {
      const dotIndex = /^\.(-?\d+)/.exec(rest)!;
      segments.push({ kind: "index", index: Number(dotIndex[1]) });
      rest = rest.slice(dotIndex[0].length);
      continue;
    }
    throw new Error(`jsonPath 片段无法解析: "${rest}" (完整路径 ${path})`);
  }

  return (data: unknown): unknown => {
    let cursor: unknown = data;
    for (const segment of segments) {
      if (cursor === null || cursor === undefined) return undefined;
      if (segment.kind === "index") {
        if (!Array.isArray(cursor)) return undefined;
        cursor = cursor[segment.index];
      } else {
        if (typeof cursor !== "object") return undefined;
        cursor = (cursor as Record<string, unknown>)[segment.key];
      }
    }
    return cursor;
  };
}

function normalizeTrend(value: unknown): KpiCard["trend"] {
  if (value === "up" || value === "down" || value === "flat" || value === "unknown") return value;
  return "unknown";
}

function normalizeValue(value: unknown, unit: string | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return unit ? `${value}${unit}` : String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const looksNumeric = /^-?\d+(\.\d+)?$/.test(value.trim());
    return looksNumeric && unit ? `${value}${unit}` : value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** static source → 卡片 */
export function normalizeStaticCard(source: KpiSourceConfig, updatedAt: string): KpiCard {
  const value = normalizeValue(source.value, typeof source.unit === "string" ? source.unit : undefined);
  const delta = typeof source.delta === "string" && source.delta !== "" ? source.delta : null;
  return {
    id: source.id,
    title: source.title,
    value,
    trend: normalizeTrend(source.trend),
    delta,
    updatedAt,
    link: typeof source.link === "string" && source.link !== "" ? source.link : null,
    error: null,
  };
}

/** http-json 拉取结果 → 卡片 */
export function normalizeHttpCard(source: KpiSourceConfig, data: unknown, updatedAt: string): KpiCard {
  const base: KpiCard = {
    id: source.id,
    title: source.title,
    value: "",
    trend: "unknown",
    delta: null,
    updatedAt,
    link: typeof source.link === "string" && source.link !== "" ? source.link : null,
    error: null,
  };
  if (typeof source.jsonPath !== "string" || source.jsonPath.trim() === "") {
    return { ...base, error: "http-json source 缺少 jsonPath" };
  }
  let extracted: unknown;
  try {
    extracted = parseJsonPath(source.jsonPath)(data);
  } catch (err) {
    return { ...base, error: `jsonPath 非法: ${(err as Error).message}` };
  }
  if (extracted === undefined || extracted === null) {
    return { ...base, error: `jsonPath 未找到: ${source.jsonPath}` };
  }
  return {
    ...base,
    value: normalizeValue(extracted, typeof source.unit === "string" ? source.unit : undefined),
  };
}

function errorCard(source: KpiSourceConfig, message: string, updatedAt: string): KpiCard {
  return {
    id: typeof source.id === "string" ? source.id : "unknown",
    title: typeof source.title === "string" ? source.title : "",
    value: "",
    trend: "unknown",
    delta: null,
    updatedAt,
    link: typeof source.link === "string" && source.link !== "" ? source.link : null,
    error: message,
  };
}

/** 解析 kpi-sources.json 文本（错误容忍：单条非法跳过） */
export function parseSources(content: string): KpiSourceConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`kpi-sources.json 解析失败: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as KpiSourcesFile).sources)) {
    throw new Error("kpi-sources.json 结构非法：需要 { sources: [...] }");
  }
  return (parsed as KpiSourcesFile).sources.filter(
    (s): s is KpiSourceConfig => typeof s === "object" && s !== null && typeof (s as KpiSourceConfig).id === "string",
  );
}

export interface KpiServiceOptions {
  configDir: string;
  kpiRefreshMinutes?: number;
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export class KpiService {
  private readonly configDir: string;
  private readonly refreshMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private cards: KpiCard[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KpiServiceOptions) {
    this.configDir = options.configDir;
    this.refreshMs = (options.kpiRefreshMinutes ?? 5) * 60 * 1000;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  getCards(): KpiCard[] {
    return this.cards;
  }

  /** 立即刷新 + 启动定时器（unref 不阻塞进程退出） */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 重读 sources 并逐卡刷新；单卡失败不影响其它卡 */
  async refresh(): Promise<void> {
    const file = join(this.configDir, "kpi-sources.json");
    let sources: KpiSourceConfig[] = [];
    if (existsSync(file)) {
      try {
        sources = parseSources(readFileSync(file, "utf8"));
      } catch (err) {
        this.cards = [
          errorCard({ id: "kpi-config", title: "KPI 配置", type: "static" }, (err as Error).message, this.now().toISOString()),
        ];
        return;
      }
    }

    const results = await Promise.all(
      sources.map(async (source): Promise<KpiCard> => {
        const updatedAt = this.now().toISOString();
        try {
          if (source.type === "static") {
            return normalizeStaticCard(source, updatedAt);
          }
          if (source.type === "http-json") {
            if (typeof source.url !== "string" || source.url.trim() === "") {
              return errorCard(source, "http-json source 缺少 url", updatedAt);
            }
            const headers = resolveHeaders(source.headers, this.env);
            const response = await this.fetchFn(source.url, {
              headers,
              signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (!response.ok) {
              return errorCard(source, `HTTP ${response.status}`, updatedAt);
            }
            let data: unknown;
            try {
              data = await response.json();
            } catch (err) {
              return errorCard(source, `响应不是合法 JSON: ${(err as Error).message}`, updatedAt);
            }
            return normalizeHttpCard(source, data, updatedAt);
          }
          return errorCard(source, `未知 source type: ${String(source.type)}`, updatedAt);
        } catch (err) {
          // 错误信息不含请求 header，避免泄漏密钥
          return errorCard(source, (err as Error).message ?? String(err), updatedAt);
        }
      }),
    );
    this.cards = results;
  }
}
