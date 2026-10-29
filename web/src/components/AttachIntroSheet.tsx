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
 * - claude：spawn 按 hub 配置 claudeDriver.permissionMode 下发 --permission-mode（默认
 *   bypassPermissions）→ 工具在你电脑上**自动执行且无人工批准**，请只在信任的仓库用；
 *   需确认档位下需要确认的操作会在手机上弹出审批卡片（与接管路径同一审批通道、同一套 UI）
 * - codex：spawn codex exec resume，同样无人批准
 */
function parallelDesc(source: SessionSource | undefined): string {
  if (source === "claude") {
    return "由电脑上的 agent-hub server 起一个 claude 实例续聊（共享同一会话上下文）。注意：默认档位（bypassPermissions）下工具调用（读写文件、执行命令）会在你电脑上自动执行且**无人工批准**，请只在你信任的仓库使用；实际档位由 hub 配置 claudeDriver.permissionMode 决定（需确认档位下需要确认的操作会在手机上弹出审批卡片，允许/拒绝后继续）。原终端窗口不会同步显示新增消息。";
  }
  if (source === "codex") {
    return "由电脑上的 agent-hub server 起一个 codex 实例续聊（共享同一会话上下文）。命令与文件访问按 Codex 实际权限在电脑上执行。此通道无人工批准入口，需要确认的操作可能失败；原电脑窗口不会同步新增消息。";
  }
  return "由电脑上的 agent-hub server 起一个 pi 实例续聊（共享同一会话上下文）。注意：工具调用（读写文件、执行命令）会在你电脑上真实执行且**无人工批准**，请只在你信任的仓库里用。原终端窗口不会同步显示新增消息；两端共享上下文，请避免同时发送。";
}

export function AttachIntroSheet({ onPick, onClose, driver, source }: AttachIntroSheetProps) {
  const attachDesc =
    source === "codex"
      ? "由电脑上的 Codex 驱动继续同一会话，回复同步到手机，是否询问审批取决于实际设置，接管后会显示。电脑正在占用会话时请先退出原会话；退出接管后可在电脑继续。审批方式与沙箱沿用 Codex 配置。"
      : driver === "hub"
      ? "手机消息由 hub 直接驱动 claude 执行并写回同一会话，电脑终端投屏实时显示；退出接管后可 claude --resume 无缝接回。权限档位与平行模式同源（默认自动执行、无人工批准；需确认档位走手机审批卡片）。"
      : "手机消息发往电脑终端 pi 进程，终端实时显示并执行——人在电脑前，手机当遥控器。";
  return (
    <Sheet
      title="选择会话驱动模式"
      subtitle="两种模式随时可切换"
      onClose={onClose}
      footer={
        <div className="attach-intro-foot">
          {/* Codex 产品规则：默认 📱 平行（接管须先退出桌面会话），主按钮随源反转引导 */}
          <button
            type="button"
            className={`attach-intro-btn${source === "codex" ? " primary" : ""}`}
            onClick={() => onPick("parallel")}
          >
            📱 平行继续
          </button>
          <button
            type="button"
            className={`attach-intro-btn${source === "codex" ? "" : " primary"}`}
            onClick={() => onPick("attach")}
          >
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
