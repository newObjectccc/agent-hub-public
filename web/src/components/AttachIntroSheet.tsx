/**
 * 双模式一次性说明 sheet（E3）：首次进入可双模式的会话时从底部弹出，
 * 说明 📱 平行继续 / 🖥 接管终端 两种模式，选择即用（记住选择，用完即走，绝不常驻）。
 */
import type { AttachMode } from "../api/attach";
import type { SessionSource } from "../api/types";
import { Sheet } from "./Sheet";

export interface AttachIntroSheetProps {
  onPick: (mode: AttachMode) => void;
  onClose: () => void;
  /** 驱动形态（hub=claude 文案分支） */
  driver?: "queue" | "hub";
  /** 会话来源：平行模式的权限语义按源不同，不能给错信息 */
  source?: SessionSource;
}

/**
 * 平行模式的权限真相（按源）——这是用户最应该知道、却最容易缺失的一句：
 * - pi：server 进程内起 headless 实例，createAgentSession 未限制工具集 →
 *   bash/edit/write 在你电脑上**真实执行且无人批准**
 * - claude：spawn 固定带 `--permission-mode manual`，需确认的工具一律被拒（更安全但能力受限）
 * - codex：spawn codex exec resume，同样无人批准
 */
function parallelDesc(source: SessionSource | undefined): string {
  if (source === "claude") {
    return "由电脑上的 agent-hub server 起一个 claude 实例续聊（共享同一会话上下文）。权限固定为 manual：需要你确认的工具会被直接拒绝，所以能读能答、但改不了东西。原终端窗口不会同步显示新增消息。";
  }
  if (source === "codex") {
    return "由电脑上的 agent-hub server 起一个 codex 实例续聊（共享同一会话上下文）。注意：命令与文件修改会在你电脑上真实执行且无人工批准，请只在你信任的仓库里用。";
  }
  return "由电脑上的 agent-hub server 起一个 pi 实例续聊（共享同一会话上下文）。注意：工具调用（读写文件、执行命令）会在你电脑上真实执行且**无人工批准**，请只在你信任的仓库里用。原终端窗口不会同步显示新增消息；两端共享上下文，请避免同时发送。";
}

export function AttachIntroSheet({ onPick, onClose, driver, source }: AttachIntroSheetProps) {
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
          <span>{parallelDesc(source)}</span>
        </li>
        <li>
          <strong>🖥 接管终端</strong>
          <span>{attachDesc}</span>
        </li>
      </ul>
    </Sheet>
  );
}
