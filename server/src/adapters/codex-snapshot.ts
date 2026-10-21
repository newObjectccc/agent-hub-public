/**
 * rollout 持久化消息与原生 item 流具有不同 id/工具分组。
 * 只用原生 turnId 替换同一轮，保留稳定 item id 与未完成输出。
 * 老记录缺少 turnId 时保留全部历史；仅对同 id、或同时间/正文/图片的 user 一对一去重。
 */
import type { MessageDto } from "../types.js";

export function mergeCodexSnapshot(history: MessageDto[], snapshot: MessageDto[]): MessageDto[] {
  if (snapshot.length === 0) return history;
  // 无 user 的在途快照整体丢弃（有意为之，勿轻易放宽）：驱动的 snapshotFor 只在本轮 user
  // 消息已被 Codex 受理后才会带上 user（emitUser），所以「只有 assistant」通常意味着本轮被
  // 中止或未被受理，此时把流式正文并进历史既无法与 rollout 的 id 体系去重（会产生重复气泡），
  // 又会重新打开「过期快照覆盖实时消息」的竞态——磁盘历史可能已比内存快照更完整。
  if (!snapshot.some((message) => message.role === "user")) return history;
  const candidateTurnId = snapshot[0].turnId;
  const turnId = candidateTurnId && snapshot.every((message) => message.turnId === candidateTurnId) ? candidateTurnId : null;
  if (turnId) {
    const anchor = history.findIndex((message) => message.turnId === turnId);
    if (anchor >= 0) {
      const snapshotIds = new Set(snapshot.map((message) => message.id));
      // 旧快照不得抹去后续轮次、其他轮次或缺少标识的历史。
      return [
        ...history.slice(0, anchor),
        ...snapshot,
        ...history.slice(anchor).filter((message) => message.turnId !== turnId && !snapshotIds.has(message.id)),
      ];
    }
  }
  return mergeWithoutTurnAnchor(history, snapshot);
}

function mergeWithoutTurnAnchor(history: MessageDto[], snapshot: MessageDto[]): MessageDto[] {
  const byId = new Map(snapshot.map((message) => [message.id, message]));
  const existingIds = new Set(history.map((message) => message.id));
  const consumed = new Set<number>();
  const additions: MessageDto[] = [];
  for (const live of snapshot) {
    if (existingIds.has(live.id)) continue;
    let match = -1;
    if (live.role === "user" && Number.isFinite(live.timestamp) && live.timestamp > 0) {
      match = history.findIndex((message, index) =>
        !consumed.has(index) && !byId.has(message.id) && message.role === "user"
        && (!message.turnId || message.turnId === live.turnId)
        // 不同时间可能是用户连续发送的两条合法“继续”，不能吞并。
        && message.timestamp === live.timestamp && sameUserContent(message, live));
    }
    if (match >= 0) consumed.add(match);
    else additions.push(live);
  }
  return [...history.map((message) => byId.get(message.id) ?? message), ...additions];
}

function sameUserContent(left: MessageDto, right: MessageDto): boolean {
  const imagesLeft = left.images ?? [];
  const imagesRight = right.images ?? [];
  if (imagesLeft.length !== imagesRight.length || imagesLeft.some((image, index) => image.url !== imagesRight[index].url)) return false;
  const normalized = (message: MessageDto): string =>
    message.images?.length && (message.text === "" || message.text === "[image]") ? "[image]" : message.text;
  return normalized(left) === normalized(right);
}
