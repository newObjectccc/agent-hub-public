/**
 * 双模式一次性说明 sheet（E3）：首次进入可双模式的会话时从底部弹出，
 * 说明 📱 平行继续 / 🖥 接管终端 两种模式，选择即用（记住选择，用完即走，绝不常驻）。
 */
import type { AttachMode } from "../api/attach";
import { Sheet } from "./Sheet";

export interface AttachIntroSheetProps {
  onPick: (mode: AttachMode) => void;
  onClose: () => void;
  /** 驱动形态（hub=claude 文案分支） */
  driver?: "queue" | "hub";
}

export function AttachIntroSheet({ onPick, onClose, driver }: AttachIntroSheetProps) {
  const attachDesc =
    driver === "hub"
      ? "手机消息由 hub 直接驱动 claude 执行并写回同一会话，电脑终端投屏实时显示；退出接管后可 claude --resume 无缝接回。"
      : "手机消息发往电脑终端 pi 进程，终端实时显示并执行——人在电脑前，手机当遥控器。";
  return (
    <Sheet
      title="选择会话驱动模式"
      subtitle="两种模式随时可切换"
      onClose={onClose}
      footer={
        <div className="attach-intro-foot">
          <button type="button" className="attach-intro-btn" onClick={() => onPick("parallel")}>
            📱 平行继续
          </button>
          <button type="button" className="attach-intro-btn primary" onClick={() => onPick("attach")}>
            🖥 接管终端
          </button>
        </div>
      }
    >
      <ul className="attach-intro-list">
        <li>
          <strong>📱 平行继续</strong>
          <span>手机独立续聊，原终端窗口不会同步显示新增消息；两端共享上下文，请避免同时发送。</span>
        </li>
        <li>
          <strong>🖥 接管终端</strong>
          <span>{attachDesc}</span>
        </li>
      </ul>
    </Sheet>
  );
}
