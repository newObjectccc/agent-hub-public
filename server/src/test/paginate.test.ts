/**
 * 会话消息分页纯函数测试（GET /api/sessions/:id?before=&limit= 契约补充）。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_PAGE_LIMIT,
  fullPage,
  MAX_PAGE_LIMIT,
  paginateMessages,
  parseLimit,
} from "../sessions/paginate.js";
import type { MessageDto } from "../types.js";

function msgs(count: number): MessageDto[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    timestamp: 1000 + i,
    text: `t${i + 1}`,
    toolCalls: [],
  }));
}

describe("paginateMessages：尾部窗口（首屏懒加载）", () => {
  it("limit 小于总数 → 尾部 limit 条，hasMore=true，nextBefore=窗口最早 id", () => {
    const page = paginateMessages(msgs(10), { limit: 3 });
    assert.deepEqual(page.messages.map((m) => m.id), ["m8", "m9", "m10"]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, "m8");
  });

  it("limit 大于等于总数 → 全量，hasMore=false，nextBefore=null", () => {
    const page = paginateMessages(msgs(4), { limit: 10 });
    assert.equal(page.messages.length, 4);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null);
  });

  it("缺省 limit 用 DEFAULT_PAGE_LIMIT", () => {
    const page = paginateMessages(msgs(DEFAULT_PAGE_LIMIT + 2), {});
    assert.equal(page.messages.length, DEFAULT_PAGE_LIMIT);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, "m3");
  });

  it("空列表 → 空页", () => {
    const page = paginateMessages([], { limit: 5 });
    assert.deepEqual(page.messages, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null);
  });
});

describe("paginateMessages：before 游标（上滑加载更早消息）", () => {
  it("返回游标之前（不含）的最近 limit 条", () => {
    const page = paginateMessages(msgs(10), { before: "m8", limit: 3 });
    assert.deepEqual(page.messages.map((m) => m.id), ["m5", "m6", "m7"]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, "m5");
  });

  it("更早消息不足 limit 页 → hasMore=false", () => {
    const page = paginateMessages(msgs(10), { before: "m3", limit: 3 });
    assert.deepEqual(page.messages.map((m) => m.id), ["m1", "m2"]);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null);
  });

  it("游标即第一条 → 空页，hasMore=false", () => {
    const page = paginateMessages(msgs(10), { before: "m1", limit: 5 });
    assert.deepEqual(page.messages, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null);
  });

  it("未知游标退化为尾部窗口（幂等安全）", () => {
    const page = paginateMessages(msgs(6), { before: "nope", limit: 2 });
    assert.deepEqual(page.messages.map((m) => m.id), ["m5", "m6"]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, "m5");
  });

  it("before 未带 limit → 默认页大小", () => {
    const page = paginateMessages(msgs(80), { before: "m80" });
    assert.equal(page.messages.length, DEFAULT_PAGE_LIMIT);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, "m30");
  });
});

describe("parseLimit / fullPage", () => {
  it("缺省返回 undefined（全量语义）", () => {
    assert.equal(parseLimit(undefined), undefined);
    assert.equal(parseLimit(null), undefined);
    assert.equal(parseLimit(""), undefined);
  });

  it("合法整数原样返回", () => {
    assert.equal(parseLimit("50"), 50);
    assert.equal(parseLimit(1), 1);
    assert.equal(parseLimit(String(MAX_PAGE_LIMIT)), MAX_PAGE_LIMIT);
  });

  it("非法值返回 null（调用方 400）", () => {
    for (const bad of ["0", "-3", "1.5", "abc", String(MAX_PAGE_LIMIT + 1), NaN]) {
      assert.equal(parseLimit(bad), null, String(bad));
    }
  });

  it("fullPage 保持 v0 全量语义", () => {
    const all = msgs(7);
    const page = fullPage(all);
    assert.equal(page.messages.length, 7);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null);
  });
});
