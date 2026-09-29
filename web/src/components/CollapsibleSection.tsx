/**
 * 可折叠小节（野兽派）：标题行点击 toggle，高度/透明度 220ms 动画，展开状态存 localStorage（默认展开）。
 * 动画只在真实交互（点击 toggle）时发生：初始渲染直接落到最终态，刷新/重挂不播动画、不重排。
 * 高度动画用 grid-template-rows 0fr ↔ 1fr（内容高度变化自动跟随，无需测量）。
 */
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  children,
}: {
  /** 标题行文案 */
  title: ReactNode;
  /** localStorage 状态键（存 "1" 展开 / "0" 收起） */
  storageKey: string;
  /** 无存储记录时的默认状态（默认展开） */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const saved = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
      return saved === null ? defaultOpen : saved === "1";
    } catch {
      return defaultOpen;
    }
  });

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      // 存储失败不阻塞 UI，下次回到默认展开
    }
  };

  return (
    <section className="collapse-section">
      <button type="button" className="section-title section-toggle" aria-expanded={open} onClick={toggle}>
        <span>{title}</span>
        <span className={cn("collapse-arrow", open && "open")} aria-hidden>
          ▸
        </span>
      </button>
      <div className={cn("collapse-body", !open && "closed")} aria-hidden={!open}>
        <div className="collapse-inner">{children}</div>
      </div>
    </section>
  );
}
