/**
 * 会话筛选底部面板（来源多选）：复用 Sheet（焦点陷阱/Esc/焦点归还）。
 *
 * 交互口径（移动端行业习惯：App Store/淘宝/Linear 同款）：
 * - chips 多选 = 并集；带计数辅助决策（"pi 60"）
 * - footer 双动作：[重置] 清空条件（幂等可点）/[查看 N 个] 应用并关闭（实时预览结果数）
 * - 筛选状态留在页面层（chips 条持久展示 + 逐个 ✕ 移除），关闭面板不丢选择
 */
import { Sheet } from "./Sheet";
import { SOURCE_OPTIONS } from "../utils/sessionFilter";
import { cn } from "@/lib/utils";

export function SessionFilterSheet({
  counts,
  active,
  resultCount,
  onToggle,
  onReset,
  onClose,
}: {
  counts: Record<string, number>;
  active: ReadonlySet<string>;
  /** 当前条件下剩余结果数（实时预览，按钮文案即预期） */
  resultCount: number;
  onToggle: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="筛选"
      subtitle="多选来源为并集；不选 = 全部"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="filter-reset" onClick={onReset} disabled={active.size === 0}>
            重置
          </button>
          <button type="button" className="filter-apply" onClick={onClose}>
            查看 {resultCount} 个
          </button>
        </>
      }
    >
      <div className="filter-group">
        <div className="filter-group-label">来源 / Agent</div>
        <div className="filter-chipset" role="group" aria-label="来源筛选">
          {SOURCE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={cn("filter-chip", active.has(o.value) && "on")}
              aria-pressed={active.has(o.value)}
              onClick={() => onToggle(o.value)}
            >
              {o.label}
              <span className="filter-count">{counts[o.value] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
