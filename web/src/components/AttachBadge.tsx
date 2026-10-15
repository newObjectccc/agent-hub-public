/**
 * 会话列表驱动方式徽章（E3，紧凑小徽章）：
 * 🖥⚡ 已接管 / 🖥 终端在线|可接管 / 📱 平行线。
 * 320 窄屏只留 emoji（.badge-text-long 隐藏），title/aria 保留完整语义。
 * hub 形态（claude）：未接管的仅活跃会话显示「可接管」（status 判定），历史空闲不显示。
 */
import type { SessionStatus, TerminalAttachInfo } from "../api/types";
import { attachBadge } from "../api/attach";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

export function AttachBadge({
  terminal,
  status,
}: {
  terminal?: TerminalAttachInfo | null;
  status?: SessionStatus;
}) {
  const info = attachBadge(terminal, status);
  if (!info) return null;
  return (
    <Badge
      variant="outline"
      className={cn("badge", "attach-badge", `attach-${info.variant}`)}
      /* 窄屏隐藏文字后仅剩 emoji（title 触屏/读屏不可达）→ role=img + aria-label 兜底完整语义 */
      role="img"
      aria-label={info.title}
      title={info.title}
    >
      <span aria-hidden="true">{info.icon}</span>
      <span className="badge-text-long"> {info.label}</span>
    </Badge>
  );
}
