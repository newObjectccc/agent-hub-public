import type { SessionStatus } from "../api/types";

const LABEL: Record<SessionStatus, string> = {
  idle: "空闲",
  running: "运行中",
  error: "错误",
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`badge ${status}`}>{LABEL[status] ?? status}</span>;
}
