/**
 * 进场动画一次性：只在条目首次出现时标记（用于 CSS enter 动画），
 * 数据刷新/重新渲染/tab 切换均不重播动画（seen 持续累积，见过即永不再播）。
 * 纯决策 computeNewIds 可单测；hook 只是持有 seen 的 ref。
 * 可传 externalSeen（跨组件卸载持久的容器）：空分类 tab 往返不重播（AC3-b）。
 */
import { useRef } from "react";

/** 本次 id 集合中「首次出现」的子集（纯函数，不修改入参） */
export function computeNewIds(seen: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const newIds = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id) && !newIds.has(id)) newIds.add(id);
  }
  return newIds;
}

/**
 * 返回本批次首次出现的 id 集合；同一批次内首次渲染即标记，
 * 后续任何重渲染/数据刷新对已见 id 不再标记（零动画）。
 * externalSeen：跨卸载持久的 seen 容器（父级 useRef 持有），缺省用内部 ref。
 */
export function useFirstSeen(ids: readonly string[], externalSeen?: Set<string>): Set<string> {
  const internalRef = useRef<Set<string>>(new Set());
  const seen = externalSeen ?? internalRef.current;
  const newIds = computeNewIds(seen, ids);
  for (const id of newIds) seen.add(id);
  return newIds;
}
