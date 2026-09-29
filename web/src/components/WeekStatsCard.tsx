/**
 * 「本周统计」卡：🔥连续活跃天数(streak) · 💬本周消息 · ✅本周完成会话 · 🌿本周 commits。
 * 全部来自 /api/dashboard/stats 的真实推导字段。
 */
import type { DashboardStats } from "../api/types";

interface CellProps {
  icon: string;
  label: string;
  value: number | null;
  unit?: string;
}

function StatCell({ icon, label, value, unit }: CellProps) {
  return (
    <div className="week-cell">
      <div className="week-cell-label">
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="week-cell-value">
        {value === null ? "…" : value}
        {value !== null && unit && <span className="week-cell-unit">{unit}</span>}
      </div>
    </div>
  );
}

export function WeekStatsCard({ stats, loaded }: { stats: DashboardStats | null; loaded: boolean }) {
  const v = (n: number | undefined): number | null => (loaded && stats ? (n ?? 0) : null);
  return (
    <div className="card week-card" role="status" aria-label="本周统计">
      <StatCell icon="🔥" label="连续活跃" value={v(stats?.streak)} unit="天" />
      <StatCell icon="💬" label="本周消息" value={v(stats?.weekMessages)} />
      <StatCell icon="✅" label="本周完成" value={v(stats?.weekDone)} unit="会话" />
      <StatCell icon="🌿" label="本周 commits" value={v(stats?.weekCommits)} />
    </div>
  );
}
