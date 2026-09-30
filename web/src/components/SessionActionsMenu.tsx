/**
 * 会话操作菜单（chat 顶栏"⋯"）：目前提供「复制为新会话」（fork）。
 * 野兽派下拉：厚描边 + 硬阴影；点外部 / Esc 关闭（useDismissable，与其他弹层互斥）；触控目标 ≥44px。
 */
import { useRef, useState } from "react";
import { useDismissable } from "../hooks/useDismissable";
import { CopyIcon, MoreIcon } from "./icons";

export interface SessionActionsMenuProps {
  onFork: () => void;
  forkBusy?: boolean;
}

export function SessionActionsMenu({ onFork, forkBusy = false }: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useDismissable({ open, onDismiss: () => setOpen(false), rootRef: wrapRef });

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
            title="复制完整上下文到全新会话（推荐：避免电脑端 pi 与手机面板同时驱动一个会话）"
            onClick={() => {
              setOpen(false);
              onFork();
            }}
          >
            <CopyIcon />
            <span>{forkBusy ? "复制中…" : "复制为新会话"}</span>
          </button>
          <p className="action-menu-hint">
            复制完整上下文到新会话；手机面板发消息后，电脑端 pi 需重新打开原会话才能看到，
            复制新会话可避免两个进程同时驱动一个会话（推荐）。
          </p>
        </div>
      )}
    </div>
  );
}
