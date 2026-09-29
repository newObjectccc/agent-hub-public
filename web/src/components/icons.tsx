/** 内联 SVG 图标（不引图标库，控制依赖体积） */
import type { ToolCallStatus } from "../api/types";

export function TrendIcon({ trend }: { trend: "up" | "down" | "flat" | "unknown" }) {
  if (trend === "up") return <span className="kpi-trend up">↑</span>;
  if (trend === "down") return <span className="kpi-trend down">↓</span>;
  if (trend === "flat") return <span className="kpi-trend flat">→</span>;
  return <span className="kpi-trend unknown">·</span>;
}

export function ToolStatusIcon({ status }: { status: ToolCallStatus }) {
  const cls = `tool-icon ${status}`;
  switch (status) {
    case "done":
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-label="完成">
          <path
            d="M3 8.5l3.2 3.2L13 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "error":
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-label="失败">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "running":
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-label="运行中">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-label="等待">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}

export function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M15 5l-7 7 7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
