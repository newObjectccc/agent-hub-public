/**
 * 搜索深链定位（UX 审查 AC2）：
 * - ?m= 精确 id 优先，回落 ?q= 文本匹配
 * - miss 时按 before 游标自动加载更早页直到命中（≤上限页数防无限拉取）
 * - 仍未命中返回 null（调用方 toast 轻提示）；加载出错不阻断
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../api/types";
import { LOCATE_MAX_PAGES, locateWithPaging } from "./locate";
import { locateHitId } from "../utils/search";

function msg(id: string, text: string): SessionMessage {
  return { id, role: "user", timestamp: 0, text, toolCalls: [] };
}

/** 模拟按 before 游标分页的历史（越早越小 id）：m01..m20，每页 3 条 */
function makeHistory(): SessionMessage[] {
  return Array.from({ length: 20 }, (_, i) => msg(`m${String(i + 1).padStart(2, "0")}`, `第 ${i + 1} 条消息`));
}

function pagedLoader(history: SessionMessage[], pageSize = 3) {
  return vi.fn(async (beforeId: string) => {
    const idx = history.findIndex((m) => m.id === beforeId);
    const start = Math.max(0, idx - pageSize);
    return { messages: history.slice(start, idx), hasMore: start > 0 };
  });
}

describe("locateHitId（?m= 优先，回落 ?q=）", () => {
  const messages = [msg("a", "hello world"), msg("b", "第二条消息"), msg("c", "hello again")];

  it("?m= 精确命中优先", () => {
    expect(locateHitId(messages, { messageId: "b", q: "hello" })).toBe("b");
  });

  it("?m= 未命中回落 ?q= 文本匹配", () => {
    expect(locateHitId(messages, { messageId: "zzz", q: "again" })).toBe("c");
  });

  it("无参数/均未命中 → null", () => {
    expect(locateHitId(messages, {})).toBeNull();
    expect(locateHitId(messages, { q: "不存在的词" })).toBeNull();
    expect(locateHitId(messages, { messageId: "zzz" })).toBeNull();
  });
});

describe("locateWithPaging（miss 自动回溯更早页）", () => {
  it("已加载范围命中：不加载更早页", async () => {
    const history = makeHistory();
    const loadOlder = pagedLoader(history);
    const tail = history.slice(17); // m18..m20
    const result = await locateWithPaging({
      messages: tail,
      hasMore: true,
      target: { q: "第 18 条消息" },
      loadOlder,
    });
    expect(result.hitId).toBe("m18");
    expect(result.pagesLoaded).toBe(0);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("命中更早消息：按 before 游标加载多页直到命中（旧实现只看尾部会静默失败）", async () => {
    const history = makeHistory();
    const loadOlder = pagedLoader(history);
    const merged: SessionMessage[][] = [];
    const result = await locateWithPaging({
      messages: history.slice(17), // 尾部 m18..m20
      hasMore: true,
      target: { q: "第 2 条消息" }, // m02 在很早的页（≤6 页可达）
      loadOlder,
      onPageMerged: (list) => merged.push(list),
    });
    expect(result.hitId).toBe("m02");
    expect(result.pagesLoaded).toBeGreaterThan(0);
    expect(merged.length).toBe(result.pagesLoaded);
    // before 游标逐页向前（不重复、不跳页）
    const cursors = loadOlder.mock.calls.map((c) => c[0]);
    expect(cursors[0]).toBe("m18");
    expect(cursors[1]).toBe("m15");
  });

  it("翻到上限页数仍未命中 → 返回 null（调用方 toast 轻提示），不无限拉取", async () => {
    const history = makeHistory();
    const loadOlder = pagedLoader(history);
    const result = await locateWithPaging({
      messages: history.slice(17),
      hasMore: true,
      target: { q: "完全不存在" },
      loadOlder,
      maxPages: 2,
    });
    expect(result.hitId).toBeNull();
    expect(result.pagesLoaded).toBe(2);
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("上限默认 ~6 页（防无限拉取）", () => {
    expect(LOCATE_MAX_PAGES).toBe(6);
  });

  it("无更多历史（hasMore=false）→ 不加载、miss 即返回 null", async () => {
    const history = makeHistory();
    const loadOlder = pagedLoader(history);
    const result = await locateWithPaging({
      messages: history.slice(17),
      hasMore: false,
      target: { q: "第 1 条消息" },
      loadOlder,
    });
    expect(result.hitId).toBeNull();
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("加载出错不阻断页面：停止回溯并返回当前结果", async () => {
    const history = makeHistory();
    const loadOlder = vi.fn(async () => {
      throw new Error("network");
    });
    const result = await locateWithPaging({
      messages: history.slice(17),
      hasMore: true,
      target: { q: "第 1 条消息" },
      loadOlder,
    });
    expect(result.hitId).toBeNull();
    expect(result.pagesLoaded).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  it("?m= 精确 id 也能在更早页被找到", async () => {
    const history = makeHistory();
    const loadOlder = pagedLoader(history);
    const result = await locateWithPaging({
      messages: history.slice(17),
      hasMore: true,
      target: { messageId: "m05" },
      loadOlder,
    });
    expect(result.hitId).toBe("m05");
  });
});
