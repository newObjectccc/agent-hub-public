/**
 * 产物新版本提示条（「永远跑最新代码」的机制化兜底）：
 * 检测到服务端入口 hash ≠ 当前运行的入口 hash（发版/并行构建竞态/陈旧缓存）→
 * 常驻一行「点击刷新」，把"跑的不是最新代码"从玄学体验问题变成可见提示。
 */
import { useNewVersion } from "../hooks/useNewVersion";

export function NewVersionBanner() {
  const hasNew = useNewVersion();
  if (!hasNew) return null;
  return (
    <button type="button" className="new-version-banner" onClick={() => window.location.reload()}>
      🔄 发现新版本，点击刷新
    </button>
  );
}
