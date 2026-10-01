/**
 * 会话操作菜单（chat 顶栏"⋯"）：「复制为新会话」（fork）+ 会话信息收纳区。
 * i1 头部收纳：顶栏一行放不下的次要信息（cwd / 来源 / 子代理标记）收进本菜单，
 * 信息零损失（顶栏不再常驻占位）。
 * 野兽派下拉：厚描边 + 硬阴影；点外部 / Esc 关闭（useDismissable，与其他弹层互斥）；触控目标 ≥44px。
 */
import { useRef, useState } from "react";
import { useDismissable } from "../hooks/useDismissable";
import type { SessionSummary } from "../api/types";
import { CopyIcon, MoreIcon } from "./icons";
import { DrivenBadge } from "./DrivenBadge";
import { SourceBadge } from "./SourceBadge";

export interface SessionActionsMenuProps {
  onFork: () => void;
  forkBusy?: boolean;
  /** 顶栏收纳的会话信息（i1）：cwd / 来源 / 驱动方式 / 子代理标记 */
  info?: {
    cwd?: string | null;
    source?: SessionSummary["source"] | null;
    drivenBy?: SessionSummary["lastDrivenBy"] | null;
    isSubAgent?: boolean;
  };
}

export function SessionActionsMenu({ onFork, forkBusy = false, info }: SessionActionsMenuProps) {
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
          {info && (
            <div className="action-menu-info" role="none">
              {info.cwd !== null && info.cwd !== undefined && info.cwd !== "" && (
                <div className="action-menu-info-row">
                  <span className="hint-text">目录</span>
                  <span className="action-menu-mono">{info.cwd}</span>
                </div>
              )}
              <div className="action-menu-info-row">
                <span className="hint-text">来源</span>
                <SourceBadge source={info.source ?? null} />
              </div>
              <div className="action-menu-info-row">
                <span className="hint-text">驱动</span>
                <DrivenBadge drivenBy={info.drivenBy ?? null} />
              </div>
              {info.isSubAgent === true && (
                <div className="action-menu-info-row">
                  <span className="hint-text">类型</span>
                  <span className="badge subagent">🤖 子代理</span>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            disabled={forkBusy}
            title="手机独立干活推荐：分叉后互不影响。复制完整上下文到全新会话，电脑端 pi 与手机面板各自继续，互不干扰。"
            onClick={() => {
              setOpen(false);
              onFork();
            }}
          >
            <CopyIcon />
            <span>{forkBusy ? "复制中…" : "复制为新会话"}</span>
          </button>
          <p className="action-menu-hint">
            手机独立干活推荐：分叉后互不影响。复制完整上下文到全新会话，手机面板与电脑端 pi
            各自继续、互不干扰（手机发消息是 server 的 pi 在驱动同一会话，电脑终端需 pi --resume 才能看到）。
          </p>
        </div>
      )}
    </div>
  );
}
