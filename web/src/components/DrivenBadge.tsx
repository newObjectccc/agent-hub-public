import type { SessionSummary } from "../api/types";
import { cn } from "@/lib/utils";

/**
 * 会话驱动来源徽章（心理预期管理）：
 * 📱 面板驱动 = 手机/网页面板平行续聊过；电脑端需重新载入会话查看新增消息。
 * 🖥 终端驱动 = 尚未记录面板平行续聊；来源标记不表示当前进程的所有者。
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
          ? "手机面板继续过此会话：回到电脑后请重新打开该会话，载入新增消息"
          : "尚未记录手机面板平行续聊，默认标记为终端来源"
      }
    >
      {panel ? "📱" : "🖥"}
      <span className="badge-text-long">{panel ? " 面板驱动" : " 终端驱动"}</span>
    </span>
  );
}
