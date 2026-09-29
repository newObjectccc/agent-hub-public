/**
 * 会话列表滚动位置记忆（chat 页返回列表时恢复 scrollTop）。
 * 模块级单例：HomePage 卸载/返回都会重新挂载，必须活在组件外。
 */

let savedListScrollTop = 0;

export function saveListScrollTop(top: number): void {
  savedListScrollTop = Number.isFinite(top) && top > 0 ? top : 0;
}

export function peekListScrollTop(): number {
  return savedListScrollTop;
}
