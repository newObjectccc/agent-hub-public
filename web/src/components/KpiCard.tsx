import type { KpiCard as KpiCardType } from "../api/types";
import { relativeTime } from "../utils/relativeTime";
import { TrendIcon } from "./icons";

/** KPI 卡片：title/value/trend/delta/updatedAt；点击跳 link；error 显示灰色错误态 */
export function KpiCard({ card }: { card: KpiCardType }) {
  const content = (
    <>
      <div className="kpi-title">{card.title}</div>
      {card.error ? (
        <div className="kpi-value-row">
          <span className="kpi-value">加载失败</span>
        </div>
      ) : (
        <div className="kpi-value-row">
          <span className="kpi-value">{card.value}</span>
          <TrendIcon trend={card.trend} />
        </div>
      )}
      {!card.error && card.delta != null && <div className="kpi-delta">{card.delta}</div>}
      {card.error && <div className="kpi-delta">{card.error}</div>}
      {card.updatedAt && <div className="kpi-updated">更新于 {relativeTime(card.updatedAt)}</div>}
    </>
  );

  const className = `card kpi-card${card.error ? " error" : ""}${card.link && !card.error ? " clickable" : ""}`;

  if (card.link && !card.error) {
    return (
      <a className={className} href={card.link} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return <div className={className}>{content}</div>;
}
