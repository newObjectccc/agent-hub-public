import type { SessionSummary } from "../api/types";
import { cn } from "@/lib/utils";

/**
 * 会话驱动来源徽章（心理预期管理）：
 * 📱 面板驱动 = 手机/网页面板发过消息（server 的 pi SDK 实例驱动同一会话文件，
 * 电脑终端 pi 需 pi --resume 重开才能看到）；🖥 终端驱动 = 仅电脑终端在驱动。
 * 紧凑野兽派小徽章；320 窄屏长文案由 .badge-text-long 隐藏（防 header 溢出）。
 */
export function DrivenBadge({
  drivenBy,
  className,
}: {
  drivenBy?: SessionSummary["lastDrivenBy"] | null;
  className?: string;
}) {
  if (drivenBy !== "panel" && drivenBy !== "terminal") return null;
  const panel = drivenBy === "panel";
  return (
    <span
      className={cn("badge", panel ? "driven-panel" : "driven-terminal", className)}
      title={
        panel
          ? "手机面板继续过此会话：电脑端 pi 需重开会话（pi --resume）才能看到这些消息"
          : "由电脑终端 pi / claude 进程驱动"
      }
    >
      {panel ? "📱" : "🖥"}
      <span className="badge-text-long">{panel ? " 面板驱动" : " 终端驱动"}</span>
    </span>
  );
}
