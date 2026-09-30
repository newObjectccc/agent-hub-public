/**
 * 发送归属确认状态条（E3）：发送后一行小字确认消息归属
 * （"🖥 已发往终端…" / "📱 平行线工作中…"）。
 * 独立组件 + 独立状态字（echo），不侵入 E1 阶段状态条区域；
 * 无内容时零占位（不占用 chat 空间）。
 */
import { echoText, type ChannelEchoState } from "../api/attach";

export function ChannelEcho({ echo }: { echo: ChannelEchoState | null }) {
  if (!echo) return null;
  return (
    <div className={`channel-echo ${echo.channel}${echo.phase === "failed" ? " failed" : ""}`} role="status">
      {echoText(echo)}
    </div>
  );
}
