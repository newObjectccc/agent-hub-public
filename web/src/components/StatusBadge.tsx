import { useEffect, useRef, useState } from "react";
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

/**
 * 状态徽章。状态变化时播一次 150ms 色块闪烁（只变背景色，不引发行重排）；
 * 内容更新/重渲染零动画。
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  const prevRef = useRef(status);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevRef.current === status) return;
    prevRef.current = status;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 180);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <Badge variant={VARIANT[status] ?? "outline"} className={cn("badge", status, flash && "flash")}>
      {LABEL[status] ?? status}
    </Badge>
  );
}
