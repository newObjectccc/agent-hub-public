/**
 * 系统页（/system）：CPU/内存/磁盘指标 + 环境探测（SystemStatusBar 指标轮询内置）。
 */
import { SystemStatusBar } from "../components/SystemStatus";

export function SystemPage() {
  return (
    <div className="page system-page">
      <h2 className="section-title">🖥 指标与环境</h2>
      <SystemStatusBar system={null} />
    </div>
  );
}
