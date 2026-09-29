/**
 * 会话列表 tab 分段按钮组（野兽派）：[全部] [🔥工作中] [⚠️等你处理] [✅今日完成]。
 * 切换即时过滤（父级已过滤数据），无闪烁；按钮触控目标 ≥40px。
 */
import { SESSION_TABS, type SessionTab } from "../utils/sessionTabs";
import { cn } from "@/lib/utils";

export function SessionTabs({
  value,
  counts,
  onChange,
}: {
  value: SessionTab;
  counts: Record<SessionTab, number>;
  onChange: (tab: SessionTab) => void;
}) {
  return (
    <div className="tab-group" role="tablist" aria-label="会话过滤">
      {SESSION_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={cn("tab-btn", value === tab.value && "active")}
          onClick={() => onChange(tab.value)}
        >
          <span>{tab.label}</span>
          <span className="tab-count">{counts[tab.value]}</span>
        </button>
      ))}
    </div>
  );
}
