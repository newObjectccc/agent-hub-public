/**
 * 野兽派底部弹层（modal sheet）：厚描边 + 硬阴影 + 全屏遮罩。
 * 移动优先：默认占满底部、可滚动；Esc / 遮罩点击关闭。
 * 焦点管理（UX 审查 AC6）：Tab 弹层内循环、Esc 关闭、关闭归还焦点到打开前元素。
 */
import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

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
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Tab 循环 + Esc 关闭 + 关闭归还焦点（Esc 统一走此通道，不再另挂 window 监听）
  useFocusTrap({ active: true, onClose, rootRef: sheetRef });

  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
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
