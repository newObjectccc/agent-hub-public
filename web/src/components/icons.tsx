/** 内联 SVG 图标（不引图标库，控制依赖体积） */
import type { ToolCallStatus, TreeRole } from "../api/types";

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

export function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M15 15l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function TreeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M6 4v12a2 2 0 0 0 2 2h2M6 10h6a2 2 0 0 1 2 2v0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="14" y="10" width="6" height="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="16" width="6" height="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="2" y="2" width="5" height="4" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6"        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="14" y="10" width="6" height="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="16" width="6" height="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="2" y="2" width="5" height="4" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms ease" }}
    >
      <path d="M8 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 树节点/搜索结果的 role 图标 */
export function RoleIcon({ role }: { role: TreeRole }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true as const };
  switch (role) {
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="7.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M4.5 20c0-4 3.5-6.5 7.5-6.5s7.5 2.5 7.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "assistant":
      return (
        <svg {...common}>
          <rect x="5" y="8" width="14" height="10" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 4v4M9 12.5h.01M15 12.5h.01M9.5 15.5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "toolResult":
      return (
        <svg {...common}>
          <path
            d="M14.5 6a4 4 0 0 0-5.2 5.2L4 16.5 7.5 20l5.3-5.3A4 4 0 0 0 18 9.5L15.5 12 12 8.5 14.5 6z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "custom":
      return (
        <svg {...common}>
          <path d="M4 5h16v10H9l-5 4V5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "system":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}
