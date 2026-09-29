import type { SystemStatus } from "../api/types";
import { Card } from "./ui/card";

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

/**
 * 顶部系统状态条：pi / claude 为核心来源；tmux / ttyd / tailscale 为可选增强，
 * 缺失时显示灰色"未安装"，不显示为错误。
 */
export function SystemStatusBar({ system }: { system: SystemStatus | null }) {
  if (!system) {
    return (
      <Card className="card sysbar">
        <span className="hint-text">系统状态加载中…</span>
      </Card>
    );
  }
  return (
    <Card className="card sysbar" aria-label="系统状态">
      <Chip
        label="pi"
        available={system.pi?.available === true}
        detail={system.pi?.version ? `v${system.pi.version}` : "已安装"}
      />
      <Chip
        label="claude"
        available={system.claude?.available === true}
        detail={system.claude?.version ? `v${system.claude.version}` : "已安装"}
      />
      <Chip label="tmux" available={system.tmux?.available === true} detail={system.tmux?.version} />
      <Chip label="ttyd" available={system.ttyd?.available === true} detail={system.ttyd?.version} />
      <Chip label="claude" available={system.claude?.available === true} detail={system.claude?.version} />
      <Chip
        label="tailscale"
        available={system.tailscale?.available === true}
        detail={
          system.tailscale?.available
            ? system.tailscale.loggedIn
              ? `已登录${system.tailscale.hostname ? ` · ${system.tailscale.hostname}` : ""}`
              : "未登录"
            : null
        }
      />
    </Card>
  );
}
