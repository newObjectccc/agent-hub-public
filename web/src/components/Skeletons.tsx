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
