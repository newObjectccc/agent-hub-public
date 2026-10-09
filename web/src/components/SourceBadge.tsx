import type { SessionSource } from "../api/types";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

const LABEL: Record<SessionSource, string> = {
  pi: "pi",
  claude: "claude",
  codex: "Codex",
};

/**
 * 会话来源徽章（pi / claude / Codex）：野兽派小标签，与 StatusBadge 同排。
 * 未知来源保守按 pi 展示（老数据/兼容路径）。
 */
export function SourceBadge({ source }: { source?: SessionSource | string | null }) {
  const s: SessionSource = source === "claude" || source === "codex" ? source : "pi";
  return (
    // 配色由 styles.css 的 .badge.source-* 显式控制（双主题可读），variant 统一 outline
    <Badge variant="outline" className={cn("badge", `source-${s}`)}>
      {LABEL[s]}
    </Badge>
  );
}
