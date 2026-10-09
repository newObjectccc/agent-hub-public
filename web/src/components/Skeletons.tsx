import { Card } from "./ui/card";

/**
 * 野兽派骨架屏：粗黑边框块 + 斜纹滑光微动效。
 * 仅在「无旧数据」的首屏加载时出现；有旧数据时走 stale-while-revalidate
 * （保留旧数据 + 顶部细进度条），不闪烁。
 */

function SessionBlock() {
  return (
    <div className="skeleton session-item" aria-hidden>
      <div className="skeleton-bar w-1/2" />
      <div className="skeleton-bar w-full" />
      <div className="skeleton-bar w-2/3" />
    </div>
  );
}

export function SessionListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="session-list" role="status" aria-label="会话列表加载中">
      {Array.from({ length: count }, (_, i) => (
        <SessionBlock key={i} />
      ))}
    </div>
  );
}

/**
 * 路由级懒加载骨架（代码分割 Suspense fallback）：
 * 页面 chunk 在弱网（DERP 中继）下需要额外往返，fallback 必须是可见骨架而非白屏。
 * 复用现有 skeleton / skeleton-bar / skeleton-block nb-stripe 样式，零新增 CSS。
 */
export function PageSkeleton({ label = "页面加载中" }: { label?: string }) {
  return (
    <div className="page" role="status" aria-live="polite" aria-label={label}>
      <div className="skeleton-bar-lg" aria-hidden />
      <div className="skeleton-list" aria-hidden="true">
        <div className="skeleton-block nb-stripe" style={{ height: 72, maxWidth: "100%" }} />
        <div className="skeleton-block nb-stripe" style={{ height: 56, maxWidth: "86%", animationDelay: "0.1s" }} />
        <div className="skeleton-block nb-stripe" style={{ height: 56, maxWidth: "64%", animationDelay: "0.2s" }} />
      </div>
      <div className="skeleton-bar" aria-hidden />
    </div>
  );
}

/** chat 页消息区骨架（加载历史时） */
export function ChatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="skeleton-block nb-stripe"
          style={{
            height: 56,
            maxWidth: i % 2 === 0 ? "72%" : "58%",
            marginLeft: i % 2 === 0 ? 0 : "auto",
            animationDelay: `${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}
