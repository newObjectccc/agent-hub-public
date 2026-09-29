/**
 * 进场动画一次性：只在条目首次出现时标记（用于 CSS enter 动画），
 * 数据刷新/重新渲染/tab 切换均不重播动画（seen 持续累积，见过即永不再播）。
 * 纯决策 computeNewIds 可单测；hook 只是持有 seen 的 ref。
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
 */
export function useFirstSeen(ids: readonly string[]): Set<string> {
  const seenRef = useRef<Set<string>>(new Set());
  const newIds = computeNewIds(seenRef.current, ids);
  for (const id of newIds) seenRef.current.add(id);
  return newIds;
}
