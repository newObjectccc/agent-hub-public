/**
 * 野兽派底部弹层（modal sheet）：厚描边 + 硬阴影 + 全屏遮罩。
 * 移动优先：默认占满底部、可滚动；Esc / 遮罩点击关闭。
 */
import { useEffect, type ReactNode } from "react";

export interface SheetProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 头部右侧额外操作（如“看 diff”按钮） */
  action?: ReactNode;
}

export function Sheet({ title, subtitle, onClose, children, footer, action }: SheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <div className="sheet-title-wrap">
            <div className="sheet-title">{title}</div>
            {subtitle ? <div className="sheet-subtitle">{subtitle}</div> : null}
          </div>
          {action}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
