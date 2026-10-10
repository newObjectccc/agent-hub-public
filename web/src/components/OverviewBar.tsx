/**
 * 今日概览条：🔥工作中 · ✅今日完成 · 💬今日消息 · 🌿本周 commits · 🧮今日 tokens · 🪙7天 tokens
 * 数字全部来自 /api/dashboard/stats 与 /api/usage（真实数据推导，随刷新变化）。
 * 工作中/今日完成/今日消息三格带来源细分小字（pi · claude · codex，bySource 增量字段）。
 * 用量加载失败/无数据时 token 格安静降级为占位（不崩、不挡其它格）。
 */
import type { DashboardStats, SessionSourceCounts, UsageWindows } from "../api/types";
import { formatTokens } from "../utils/usage";
import { SourceBreakdown } from "./SourceStats";

interface ChipProps {
  icon: string;
  label: string;
  value: number | string | null;
  /** 来源细分（pi 3 · claude 2 · codex 1 小字）；无细分的格不传 */
  breakdown?: SessionSourceCounts | null;
}

function OverviewChip({ icon, label, value, breakdown = null }: ChipProps) {
  return (
    <span className={`syschip overview-chip${value === null ? " off" : ""}`}>
      <span aria-hidden>{icon}</span>
      <span className="label">{label}</span>
      <span className="overview-value">{value === null ? "…" : value}</span>
      {value !== null && <SourceBreakdown counts={breakdown} className="overview-breakdown" />}
    </span>
  );
}

export function OverviewBar({
  stats,
  loaded,
  usage = null,
}: {
  stats: DashboardStats | null;
  loaded: boolean;
  /** Token 用量时间窗（/api/usage）；缺省/加载失败 → token 格显示占位 */
  usage?: UsageWindows | null;
}) {
  const v = (n: number | null): number | null => (loaded && stats ? n : null);
  return (
    <div className="card sysbar overview-bar" role="status" aria-label="今日概览">
      <OverviewChip icon="🔥" label="工作中" value={v(stats?.working ?? null)} breakdown={stats?.bySource?.working} />
      <OverviewChip icon="✅" label="今日完成" value={v(stats?.todayDone ?? null)} breakdown={stats?.bySource?.todayDone} />
      <OverviewChip icon="💬" label="今日消息" value={v(stats?.todayMessages ?? null)} breakdown={stats?.bySource?.todayMessages} />
      <OverviewChip icon="🌿" label="本周 commits" value={v(stats?.weekCommits ?? null)} />
      <OverviewChip icon="🧮" label="今日 tokens" value={usage ? formatTokens(usage.today.totalTokens) : null} />
      <OverviewChip icon="🪙" label="7天 tokens" value={usage ? formatTokens(usage.last7Days.totalTokens) : null} />
    </div>
  );
}
