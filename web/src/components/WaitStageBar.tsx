import { formatElapsed, WAIT_PHASE_META, type WaitPhase } from "../chat/waitPhase";
import { useNowTicker } from "../hooks/useNowTicker";

/**
 * 阶段化等待状态条（输入框上方）：发送中 → 🧠 思考中 → 🔧 工具执行中 → ✍️ 回复中，
 * 右侧「· 45s」已等待计时秒级跳动；阶段切换 150ms 渐变（.fade-swap，reduced-motion 降级静态文案）。
 * phase=null 时整体不渲染（完成后交给 status/连接断开提示）。
 */
export function WaitStageBar({
  phase,
  startedAt,
  disconnected,
}: {
  phase: WaitPhase | null;
  /** 本轮等待起点（ms）：计时基准（发送时刻起算） */
  startedAt: number | null;
  /** WS 断开：阶段文案后追加断线提示（信息不丢） */
  disconnected?: boolean;
}) {
  const nowMs = useNowTicker(phase !== null && startedAt !== null);
  if (phase === null || startedAt === null) return null;
  const meta = WAIT_PHASE_META[phase];
  return (
    <div className="wait-stage-bar" role="status" aria-live="polite" aria-label={`等待反馈：${meta.label}`}>
      <span className="wait-stage fade-swap" key={phase}>
        <span className="wait-stage-icon" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="wait-stage-label">{meta.label}</span>
        <span className="wait-stage-timer">· {formatElapsed(nowMs - startedAt)}</span>
      </span>
      {disconnected && <span className="wait-stage-offline">（连接断开，重连中）</span>}
    </div>
  );
}
