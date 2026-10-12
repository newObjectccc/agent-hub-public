/**
 * 聊天滚动跟随策略（纯函数）：
 * - 发送后强制回底：发送是「我要看底部」的明确意图（用户必须看到自己刚发的消息）
 * - 被动新消息：仅在贴底状态时跟随（双口径任一 <160px 即贴底）；用户上翻看历史时不乱拽
 */
export interface FollowDecision {
  /** 发送/重试触发的强制回底 */
  force: boolean;
  /** 上次 effect 时的内容总高口径距离底部（捕捉同帧“上滚 + 流式提交”） */
  distancePrev: number;
  /** 实时几何口径距离底部（捕捉内容收缩/布局变化） */
  distanceNow: number;
  threshold: number;
}

export function shouldFollowToBottom(d: FollowDecision): boolean {
  if (d.force) return true;
  return d.distancePrev < d.threshold || d.distanceNow < d.threshold;
}
