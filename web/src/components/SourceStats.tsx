/**
 * 分源统计（v0.3 工作台按会话来源区分）：
 * - SourceBreakdown：`pi 3 · claude 2 · codex 1` 小字细分（野兽派紧凑排版，移动端不挤）
 * - SourceFilterChips：来源过滤 chips（全部 / pi / claude / codex，一行轻量，带计数）
 * 数据来自 /api/dashboard/stats 的 bySource（增量字段）；老 server/部分 mock 缺字段按 0 容错。
 */
import type { SessionSource, SessionSourceCounts } from "../api/types";

export const SOURCE_KEYS = ["pi", "claude", "codex"] as const;

export const SOURCE_LABELS: Record<SessionSource, string> = {
  pi: "pi",
  claude: "claude",
  codex: "Codex",
};

/** 来源细分取数容错（缺字段/未知值按 0） */
export function sourceCountOf(counts: SessionSourceCounts | null | undefined, source: SessionSource): number {
  const n = counts ? counts[source] : 0;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** 来源细分总和（全 0 时细分行不渲染，保持紧凑） */
function totalOf(counts: SessionSourceCounts | null | undefined): number {
  return SOURCE_KEYS.reduce((acc, key) => acc + sourceCountOf(counts, key), 0);
}

/**
 * 来源细分小字：`pi 3 · claude 2 · codex 1`。
 * 无数据/全 0 渲染 null（概览格保持单行安静）。
 */
export function SourceBreakdown({
  counts,
  className = "",
}: {
  counts: SessionSourceCounts | null | undefined;
  className?: string;
}) {
  if (totalOf(counts) === 0) return null;
  return (
    <span className={className ? `source-breakdown ${className}` : "source-breakdown"} aria-label="按来源细分">
      {SOURCE_KEYS.map((key, index) => (
        <span key={key} className="source-breakdown-item">
          {index > 0 && <span aria-hidden> · </span>}
          {/* 细分小字用小写来源名（与概览格紧凑排版一致） */}
          <span className={`source-breakdown-name source-name-${key}`}>{key}</span>{" "}
          {sourceCountOf(counts, key)}
        </span>
      ))}
    </span>
  );
}

/** 来源过滤值：全部 / 某一来源 */
export type SourceFilter = SessionSource | "all";

/**
 * 来源过滤 chips（野兽派按钮行）：选中态 aria-pressed，触控目标 ≥32px，
 * 一行四个 + flex-wrap 兜底，393px 宽不挤不换行错乱。
 */
export function SourceFilterChips({
  value,
  counts,
  onChange,
  label,
}: {
  value: SourceFilter;
  counts: SessionSourceCounts | null | undefined;
  onChange: (next: SourceFilter) => void;
  label: string;
}) {
  return (
    <div className="source-filter" role="group" aria-label={label}>
      <button
        type="button"
        className={`source-filter-chip${value === "all" ? " active" : ""}`}
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        全部
      </button>
      {SOURCE_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={`source-filter-chip source-chip-${key}${value === key ? " active" : ""}`}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {SOURCE_LABELS[key]} <span className="source-filter-count">{sourceCountOf(counts, key)}</span>
        </button>
      ))}
    </div>
  );
}

/** 来源过滤（纯函数）：卡片缺 source 的老数据保守归 pi */
export function filterBySource<T extends { source?: SessionSource | string | null }>(
  cards: T[],
  filter: SourceFilter,
): T[] {
  if (filter === "all") return cards;
  return cards.filter((card) => (card.source ?? "pi") === filter);
}
