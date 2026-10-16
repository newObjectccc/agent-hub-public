import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCodexSnapshot } from "../adapters/codex-snapshot.js";
import { parseCodexRollout } from "../adapters/codex-rollout.js";
import type { MessageDto } from "../types.js";

const message = (id: string, role: "user" | "assistant", timestamp: number, text: string, turnId?: string): MessageDto => ({
  id, role, timestamp, text, toolCalls: [], ...(turnId ? { turnId } : {}),
});
const images = [{ url: "data:image/png;base64,fixture", alt: null }];

test("Codex 重连只替换相同 turnId，保留近期同文的旧轮与无标识历史", () => {
  const previous = [message("old-u", "user", 99_000, "继续", "old-turn"), message("old-a", "assistant", 99_500, "完成", "old-turn")];
  const snapshot = [message("live-user-c", "user", 100_000, "继续", "current"), message("codex-t-i", "assistant", 101_000, "进行中", "current")];
  const marker = message("marker", "assistant", 100_100, "无轮次记录");
  const history = [...previous, message("disk-u", "user", 100_050, "继续", "current"), marker, message("disk-a", "assistant", 101_000, "进", "current")];
  const merged = mergeCodexSnapshot(history, snapshot);
  assert.deepEqual(merged, [...previous, ...snapshot, marker]);
  assert.deepEqual(mergeCodexSnapshot(merged, snapshot), merged);
});

test("当前轮尚未落盘时，即使前轮刚发送相同正文也不会截断旧历史", () => {
  const history = [message("old-u", "user", 1_000, "继续", "old"), message("old-a", "assistant", 2_000, "完成", "old")];
  const snapshot = [message("live-u", "user", 10_000, "继续", "new")];
  assert.deepEqual(mergeCodexSnapshot(history, snapshot), [...history, ...snapshot]);
  const legacy = history.map(({ turnId: _turnId, ...rest }) => rest);
  assert.deepEqual(mergeCodexSnapshot(legacy, snapshot), [...legacy, ...snapshot]);
});

test("排队超过30秒仍按turnId准确合并，过期快照不删除随后其它轮", () => {
  const snapshot = [message("live-u", "user", 1_000, "排队问题", "queued"), message("live-a", "assistant", 120_000, "回答", "queued")];
  const later = [message("later-u", "user", 125_000, "下一轮", "later"), message("later-a", "assistant", 130_000, "后续回复", "later")];
  const history = [message("disk-u", "user", 110_000, "排队问题", "queued"), message("disk-a", "assistant", 120_000, "答", "queued"), ...later];
  assert.deepEqual(mergeCodexSnapshot(history, snapshot), [...snapshot, ...later]);
});

test("纯图轮次经真实rollout turnId解析后不会重复当前user和assistant", () => {
  const rows = [
    { timestamp: "2026-10-16T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "image-turn" } },
    { timestamp: "2026-10-16T00:00:00.100Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: images[0].url }] } },
    { timestamp: "2026-10-16T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "图片说明" }] } },
  ];
  const history = parseCodexRollout(rows.map((row) => JSON.stringify(row)).join("\n")).messages;
  const snapshot = [
    { ...message("live-u", "user", Date.parse(rows[1].timestamp), "", "image-turn"), images },
    message("live-a", "assistant", Date.parse(rows[2].timestamp), "图片说明", "image-turn"),
  ];
  assert.equal(history[0].text, "[image]");
  assert.deepEqual(mergeCodexSnapshot(history, snapshot), snapshot);
});

test("没有turnId仅对同时间正文user一对一去重，绝不删除原assistant", () => {
  const history = [message("disk-u", "user", 1_000, "继续"), message("disk-a", "assistant", 2_000, "旧回复")];
  const snapshot = [message("live-u1", "user", 1_000, "继续"), message("live-u2", "user", 1_000, "继续"), message("live-a", "assistant", 3_000, "新回复")];
  const merged = mergeCodexSnapshot(history, snapshot);
  assert.deepEqual(merged, [...history, snapshot[1], snapshot[2]]);
  assert.deepEqual(mergeCodexSnapshot(merged, snapshot), merged);
  const later = [message("new-user", "user", 1_001, "继续")];
  assert.deepEqual(mergeCodexSnapshot(history, later), [...history, ...later]);
});

test("无turnId纯图user只在时间及原图完全一致时去重", () => {
  const disk = { ...message("disk-u", "user", 1_000, "[image]"), images };
  const live = { ...message("live-u", "user", 1_000, ""), images };
  assert.deepEqual(mergeCodexSnapshot([disk], [live]), [disk]);
  const otherImage = { ...live, images: [{ url: "data:image/png;base64,different", alt: null }] };
  assert.deepEqual(mergeCodexSnapshot([disk], [otherImage]), [disk, otherImage]);
  const olderTurn = { ...disk, turnId: "old" };
  assert.deepEqual(mergeCodexSnapshot([olderTurn], [{ ...live, turnId: "new" }]), [olderTurn, { ...live, turnId: "new" }]);
});

test("缺少锚时按id更新已有流消息；缺时间、空快照及无user快照不误删", () => {
  const history = [message("old", "user", 0, "继续"), message("live-a", "assistant", 1, "进")];
  const snapshot = [message("new", "user", 0, "继续"), message("live-a", "assistant", 1, "进行中")];
  assert.deepEqual(mergeCodexSnapshot(history, snapshot), [history[0], snapshot[1], snapshot[0]]);
  assert.equal(mergeCodexSnapshot(history, []), history);
  assert.equal(mergeCodexSnapshot(history, [message("a", "assistant", 2, "回复")]), history);
  const mixed = [message("new", "user", 3, "继续", "one"), message("new-a", "assistant", 4, "回复", "two")];
  assert.deepEqual(mergeCodexSnapshot(history, mixed), [...history, ...mixed]);
});
