/**
 * 今日概览条：🔥工作中 · ✅今日完成 · 💬今日消息 · 🌿本周 commits
 * 数字全部来自 /api/dashboard/stats（真实数据推导，随刷新变化）。
 */
import type { DashboardStats } from "../api/types";

interface ChipProps {
  icon: string;
  label: string;
  value: number | null;
}

function OverviewChip({ icon, label, value }: ChipProps) {
  return (
    <span className={`syschip overview-chip${value === null ? " off" : ""}`}>
      <span aria-hidden>{icon}</span>
      <span className="label">{label}</span>
      <span className="overview-value">{value === null ? "…" : value}</span>
    </span>
  );
}

export function OverviewBar({ stats, loaded }: { stats: DashboardStats | null; loaded: boolean }) {
  const v = (n: number | null): number | null => (loaded && stats ? n : null);
  return (
    <div className="card sysbar overview-bar" role="status" aria-label="今日概览">
      <OverviewChip icon="🔥" label="工作中" value={v(stats?.working ?? null)} />
      <OverviewChip icon="✅" label="今日完成" value={v(stats?.todayDone ?? null)} />
      <OverviewChip icon="💬" label="今日消息" value={v(stats?.todayMessages ?? null)} />
      <OverviewChip icon="🌿" label="本周 commits" value={v(stats?.weekCommits ?? null)} />
    </div>
  );
}
