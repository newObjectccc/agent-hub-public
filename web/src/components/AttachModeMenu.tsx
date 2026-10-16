/**
 * 双模式切换徽章（E3 + J1 图标化）：chat 顶栏一个纯图标紧凑触发器（🖥 终端显示器 / 📱 手机图形，
 * 不带文字——窄屏文字看不清/看不到的根治），点击弹出小菜单二选一（每项 icon + 一句话说明）。
 * 语义零丢失：触发器 aria-label / title 带完整模式名与说明，菜单项 icon 在文字前便于视觉区分。
 * 接管不可用（终端离线/扩展未装）时接管项灰显 + 原因。
 */
import { useRef, useState } from "react";
import type { SessionSource, TerminalAttachInfo } from "../api/types";
import { attachAvailability, type AttachMode } from "../api/attach";
import { useDismissable } from "../hooks/useDismissable";
import { CaretDownIcon, MonitorIcon, PhoneIcon } from "./icons";

export interface AttachModeMenuProps {
  mode: AttachMode;
  terminal: TerminalAttachInfo | null | undefined;
  /** 会话来源（codex 灰显文案区分用） */
  source?: SessionSource;
  onChange: (mode: AttachMode) => void;
  busy?: boolean;
}

const PARALLEL_HINT = "手机消息由 server 里的实例继续处理（双方互不干扰）";

/** hub 形态（claude）的平行模式说明：历史会话默认平行、接管可手动切换（预期管理） */
const PARALLEL_HINT_HUB =
  "手机消息由 server 里的 claude 实例继续处理（双方互不干扰）。历史会话默认此模式；想让 hub 接管执行可切换 🖥 接管终端";

/** attach hint 按驱动形态分支（D9）：pi=注入终端 TUI；claude=hub 驱动 + 投屏 */
function attachHint(terminal: TerminalAttachInfo | null | undefined): string {
  if (terminal?.source === "codex") return "由电脑上的 Codex 驱动继续同一会话，回复与审批同步到手机。电脑正在占用会话时需先退出原会话；退出接管后可在电脑继续。";
  if (terminal?.driver === "hub") {
    return "手机消息由 hub 直接驱动 claude 执行并写回同一会话，电脑终端投屏实时显示。接管期间请勿在电脑原窗口继续输入；退出接管后可 claude --resume 无缝接回";
  }
  return "手机消息发往电脑终端 pi 进程，终端实时显示并执行";
}

function modeHint(mode: AttachMode, terminal: TerminalAttachInfo | null | undefined): string {
  if (mode === "attach") return attachHint(terminal);
  if (terminal?.source === "codex") return "通过 Codex 命令行继续同一会话，原电脑窗口不会同步新增消息。两端请避免同时发送。";
  return terminal?.driver === "hub" ? PARALLEL_HINT_HUB : PARALLEL_HINT;
}

/** 模式短名（aria-label / title / 菜单文字用；触发器本体不显示文字） */
const MODE_NAMES: Record<AttachMode, string> = {
  parallel: "平行继续",
  attach: "接管终端",
};

/** 模式图形（纯图标区分：手机图形 vs 终端显示器；icon 在菜单文字前） */
function ModeIcon({ mode }: { mode: AttachMode }) {
  return mode === "attach" ? <MonitorIcon /> : <PhoneIcon />;
}

export function AttachModeMenu({ mode, terminal, source, onChange, busy }: AttachModeMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const { attachEnabled, attachDisabledReason } = attachAvailability(terminal, source);

  useDismissable({ open, onDismiss: () => setOpen(false), rootRef: wrapRef, anchorRefs: [btnRef] });

  return (
    <div className="attach-menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="attach-trigger icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`会话驱动模式：${MODE_NAMES[mode]}（点击切换）`}
        title={`会话驱动模式：${MODE_NAMES[mode]}——${modeHint(mode, terminal)}`}
        disabled={busy === true}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="attach-trigger-icon" aria-hidden="true">
          <ModeIcon mode={mode} />
        </span>
        <span className="attach-trigger-caret" aria-hidden="true">
          <CaretDownIcon />
        </span>
      </button>
      {open && (
        <div className="attach-menu" role="menu" aria-label="会话驱动模式选择">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "parallel"}
            className={`attach-menu-item${mode === "parallel" ? " active" : ""}`}
            onClick={() => {
              onChange("parallel");
              setOpen(false);
              btnRef.current?.focus();
            }}
          >
            <span className="attach-menu-label">
              <span className="attach-menu-icon" aria-hidden="true">
                <PhoneIcon />
              </span>
              平行继续
            </span>
            <span className="attach-menu-hint">{modeHint("parallel", terminal)}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "attach"}
            className={`attach-menu-item${mode === "attach" ? " active" : ""}${attachEnabled ? "" : " disabled"}`}
            aria-disabled={!attachEnabled}
            title={attachEnabled ? attachHint(terminal) : (attachDisabledReason ?? "")}
            onClick={() => {
              if (!attachEnabled) return;
              onChange("attach");
              setOpen(false);
              btnRef.current?.focus();
            }}
          >
            <span className="attach-menu-label">
              <span className="attach-menu-icon" aria-hidden="true">
                <MonitorIcon />
              </span>
              接管终端
            </span>
            <span className="attach-menu-hint">{attachEnabled ? attachHint(terminal) : attachDisabledReason}</span>
          </button>
        </div>
      )}
    </div>
  );
}
