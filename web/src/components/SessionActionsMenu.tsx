/**
 * 会话操作菜单（chat 顶栏"⋯"）：目前提供「复制为新会话」（fork）。
 * 野兽派下拉：厚描边 + 硬阴影；点外部 / Esc 关闭；触控目标 ≥44px。
 */
import { useEffect, useRef, useState } from "react";
import { CopyIcon, MoreIcon } from "./icons";

export interface SessionActionsMenuProps {
  onFork: () => void;
  forkBusy?: boolean;
}

export function SessionActionsMenu({ onFork, forkBusy = false }: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="action-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="tool-btn"
        aria-label="会话操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="action-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            disabled={forkBusy}
            onClick={() => {
              setOpen(false);
              onFork();
            }}
          >
            <CopyIcon />
            <span>{forkBusy ? "复制中…" : "复制为新会话"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
