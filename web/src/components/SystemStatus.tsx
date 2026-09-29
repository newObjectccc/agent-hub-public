import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SystemMetrics, SystemStatus } from "../api/types";
import { Card } from "./ui/card";

/** 指标轮询间隔（需求区间 5-10s 取 8s；页面隐藏时暂停） */
const METRICS_POLL_MS = 8000;

interface ChipProps {
  label: string;
  available: boolean;
  detail?: string | null;
}

function Chip({ label, available, detail }: ChipProps) {
  return (
    <span className={`syschip${available ? "" : " off"}`}>
      <span className="dot" />
      <span className="label">{label}</span>
      <span>{available ? (detail ?? "已安装") : "未安装"}</span>
    </span>
  );
}

/** 字节数 → 人类可读（GB / MB / KB，1 位小数） */
export function fmtBytes(bytes: number): string {
  const gb = 1024 ** 3;
  const mb = 1024 ** 2;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** 百分比展示：整数不带小数，否则 1 位小数 */
export function fmtPercent(percent: number): string {
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/** 秒 → "3d 4h" / "5h 12m" / "23m" */
export function fmtUptime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

/** 进度条超过该阈值转警示色 */
const WARN_PERCENT = 85;

/**
 * 野兽派指标条：标签 + 百分比 + 进度条 + 数字明细。
 * percent=null 时降级为"不可用"态（灰条），不显示假数字。
 */
function MetricBar({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className={`metric${percent === null ? " na" : ""}`}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className="metric-value">{percent === null ? "—" : fmtPercent(percent)}</span>
      </div>
      <div
        className="metric-track"
        role="progressbar"
        aria-label={`${label}使用率`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={percent === null ? "不可用" : fmtPercent(percent)}
      >
        <div className={`metric-fill${percent !== null && percent >= WARN_PERCENT ? " warn" : ""}`} style={{ width: `${clamped}%` }} />
      </div>
      <div className="metric-detail" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function metricsOf(system: SystemStatus | null): SystemMetrics | null {
  return system?.metrics ?? null;
}

/**
 * 系统状态区（真实指标为主视觉，环境探测降为"环境"行）：
 * - CPU / 内存 / 磁盘 各一条野兽派进度条（百分比 + 数字），小屏单列、≥768px 三列
 * - 指标 8s 轮询（复用 GET /api/system；失败保留上次值），采集中不闪烁
 * - 原依赖安装检测（pi/claude/tmux/ttyd/tailscale）保留为"环境"行
 * - 任一指标采集失败优雅降级（— / 不可用），不让整卡挂掉
 */
export function SystemStatusBar({ system }: { system: SystemStatus | null }) {
  const [live, setLive] = useState<SystemStatus | null>(system);
  // 首页手动刷新拿到的新值同步进来
  useEffect(() => {
    if (system) setLive(system);
  }, [system]);

  // 轻量轮询：只拉 /api/system；失败/页面隐藏时保持安静（不闪不报错）
  const pollRef = useRef(() => api.getSystem());
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await pollRef.current();
        if (alive) setLive(next);
      } catch {
        // 轮询失败保留上次数据，不弹错
      }
    };
    const timer = setInterval(() => void tick(), METRICS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!live) {
    return (
      <Card className="card syscard">
        <span className="hint-text">系统状态加载中…</span>
      </Card>
    );
  }

  const metrics = metricsOf(live);
  const cpuDetail = metrics
    ? metrics.cpu.usagePercent === null
      ? `${metrics.cpu.cores} 核 · 采样不可用`
      : `${metrics.cpu.cores} 核${metrics.loadavg ? ` · load ${metrics.loadavg.map((n) => n.toFixed(2)).join(" ")}` : ""}`
    : "指标不可用";
  const memDetail = metrics ? `${fmtBytes(metrics.memory.usedBytes)} / ${fmtBytes(metrics.memory.totalBytes)}` : "指标不可用";
  const diskDetail = metrics
    ? metrics.disk
      ? `${fmtBytes(metrics.disk.usedBytes)} / ${fmtBytes(metrics.disk.totalBytes)} · ${metrics.disk.mount}`
      : "不可用"
    : "指标不可用";

  return (
    <Card className="card syscard" aria-label="系统状态">
      <div className="sys-metrics">
        <MetricBar label="CPU" percent={metrics?.cpu.usagePercent ?? null} detail={cpuDetail} />
        <MetricBar label="内存" percent={metrics?.memory.usagePercent ?? null} detail={memDetail} />
        <MetricBar label="磁盘" percent={metrics?.disk?.usagePercent ?? null} detail={diskDetail} />
      </div>
      {metrics && (
        <div className="sys-metrics-meta">
          <span>运行 {fmtUptime(metrics.uptimeSeconds)}</span>
          {metrics.loadavg && <span>load {metrics.loadavg.map((n) => n.toFixed(2)).join(" / ")}</span>}
          <span>采样 {new Date(metrics.sampledAt).toLocaleTimeString()}</span>
        </div>
      )}
      <div className="sys-env" aria-label="环境">
        <span className="sys-env-label">环境</span>
        <Chip
          label="pi"
          available={live.pi?.available === true}
          detail={live.pi?.version ? `v${live.pi.version}` : "已安装"}
        />
        <Chip
          label="claude"
          available={live.claude?.available === true}
          detail={live.claude?.version ? `v${live.claude.version}` : "已安装"}
        />
        <Chip label="tmux" available={live.tmux?.available === true} detail={live.tmux?.version} />
        <Chip label="ttyd" available={live.ttyd?.available === true} detail={live.ttyd?.version} />
        <Chip
          label="tailscale"
          available={live.tailscale?.available === true}
          detail={
            live.tailscale?.available
              ? live.tailscale.loggedIn
                ? `已登录${live.tailscale.hostname ? ` · ${live.tailscale.hostname}` : ""}`
                : "未登录"
              : null
          }
        />
      </div>
    </Card>
  );
}
