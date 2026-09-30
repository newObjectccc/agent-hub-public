/**
 * 会话列表驱动方式徽章（E3，紧凑小徽章）：
 * 🖥⚡ 已接管 / 🖥 终端在线 / 📱 平行线。
 * 320 窄屏只留 emoji（.badge-text-long 隐藏），title/aria 保留完整语义。
 */
import type { TerminalAttachInfo } from "../api/types";
import { attachBadge } from "../api/attach";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

export function AttachBadge({ terminal }: { terminal?: TerminalAttachInfo | null }) {
  const info = attachBadge(terminal);
  if (!info) return null;
  return (
    <Badge variant="outline" className={cn("badge", "attach-badge", `attach-${info.variant}`)} title={info.title}>
      <span aria-hidden="true">{info.icon}</span>
      <span className="badge-text-long"> {info.label}</span>
    </Badge>
  );
}
