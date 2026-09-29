import type { SessionStatus } from "../api/types";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

const LABEL: Record<SessionStatus, string> = {
  idle: "空闲",
  running: "运行中",
  error: "错误",
};

const VARIANT: Record<SessionStatus, "outline" | "default" | "destructive"> = {
  idle: "outline",
  running: "default",
  error: "destructive",
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge variant={VARIANT[status] ?? "outline"} className={cn("badge", status)}>
      {LABEL[status] ?? status}
    </Badge>
  );
}
