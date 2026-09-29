import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import {
  LOAD_OLDER_SCROLL_THRESHOLD_PX,
  mergeOlderMessages,
  oldestMessageId,
  shouldLoadOlder,
  TAIL_MESSAGE_LIMIT,
} from "./history";

function msg(id: string, text = id, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id, role: "user", timestamp: 1, text, toolCalls: [], ...extra };
}

describe("mergeOlderMessages（消息分页：更早一页前插 + 去重）", () => {
  it("更早一页插到头部，尾部不动（流式新消息不被破坏）", () => {
    const current = [msg("m5"), msg("live-1", "流式中", { role: "assistant" })];
    const merged = mergeOlderMessages(current, [msg("m3"), msg("m4")]);
    expect(merged.map((m) => m.id)).toEqual(["m3", "m4", "m5", "live-1"]);
  });

  it("按 id 去重：与已有窗口重叠时不产生重复气泡", () => {
    const current = [msg("m4"), msg("m5")];
    const merged = mergeOlderMessages(current, [msg("m3"), msg("m4")]);
    expect(merged.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
  });

  it("空页 / 全重复 → 原列表不变（引用相等可跳过重渲）", () => {
    const current = [msg("m5")];
    expect(mergeOlderMessages(current, [])).toBe(current);
    expect(mergeOlderMessages(current, [msg("m5")])).toBe(current);
  });

  it("乐观占位（local-）在尾部保留", () => {
    const current = [msg("m5"), msg("local-1", "我发的")];
    const merged = mergeOlderMessages(current, [msg("m4")]);
    expect(merged.map((m) => m.id)).toEqual(["m4", "m5", "local-1"]);
  });
});

describe("oldestMessageId / shouldLoadOlder（懒加载触发）", () => {
  it("游标 = 当前最早一条消息 id", () => {
    expect(oldestMessageId([])).toBeNull();
    expect(oldestMessageId([msg("m3"), msg("m4")])).toBe("m3");
  });

  it("首屏尾部窗口默认 50 条", () => {
    expect(TAIL_MESSAGE_LIMIT).toBe(50);
  });

  it("到顶附近 + 还有更早 + 未加载中才触发", () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasMore: true, loading: false })).toBe(true);
    expect(shouldLoadOlder({ scrollTop: LOAD_OLDER_SCROLL_THRESHOLD_PX, hasMore: true, loading: false })).toBe(true);
    expect(shouldLoadOlder({ scrollTop: LOAD_OLDER_SCROLL_THRESHOLD_PX + 1, hasMore: true, loading: false })).toBe(false);
    expect(shouldLoadOlder({ scrollTop: 0, hasMore: false, loading: false })).toBe(false);
    expect(shouldLoadOlder({ scrollTop: 0, hasMore: true, loading: true })).toBe(false);
  });
});
