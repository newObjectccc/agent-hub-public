/**
 * 输入草稿持久化（UX 审查 AC1）：
 * - 按 sessionId 存/取文本草稿（附件不持久化）
 * - 30 天未动清理（防 localStorage 膨胀）；空文本即时删除
 * - 存储损坏/不可用安全降级
 */
import { describe, expect, it } from "vitest";
import {
  DRAFTS_KEY,
  DRAFT_SAVE_DEBOUNCE_MS,
  DRAFT_TTL_MS,
  clearDraft,
  loadDraft,
  parseDraftTable,
  pruneDraftTable,
  saveDraft,
  type DraftTable,
} from "./drafts";

function fakeStorage(initial: Record<string, string> = {}): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("草稿持久化（切会话/刷新/进树页不丢）", () => {
  it("saveDraft → loadDraft 按 sessionId 恢复文本；会话之间互不串", () => {
    const s = fakeStorage();
    saveDraft(s, "s1", "写一半的消息", 1000);
    saveDraft(s, "s2", "另一个会话的草稿", 1000);
    expect(loadDraft(s, "s1", 1000)).toBe("写一半的消息");
    expect(loadDraft(s, "s2", 1000)).toBe("另一个会话的草稿");
  });

  it("只存文本：附件不在草稿里（存的值是纯字符串）", () => {
    const s = fakeStorage();
    saveDraft(s, "s1", "纯文本 @path 引用", 1000);
    const table = parseDraftTable(s.getItem(DRAFTS_KEY));
    expect(table.s1).toEqual({ text: "纯文本 @path 引用", updatedAt: 1000 });
  });

  it("发送后 clearDraft 即时清理，不留已发内容", () => {
    const s = fakeStorage();
    saveDraft(s, "s1", "要发的内容", 1000);
    clearDraft(s, "s1");
    expect(loadDraft(s, "s1", 1000)).toBeNull();
  });

  it("空文本保存 = 删除条目（不占 localStorage）", () => {
    const s = fakeStorage();
    saveDraft(s, "s1", "x", 1000);
    saveDraft(s, "s1", "", 2000);
    expect(loadDraft(s, "s1", 2000)).toBeNull();
    expect(s.getItem(DRAFTS_KEY)).toBeNull();
  });

  it("30 天未动的草稿被清理（loadDraft 不到 + saveDraft 顺手清表）", () => {
    const s = fakeStorage();
    saveDraft(s, "old", "三十天前的草稿", 1000);
    saveDraft(s, "new", "新草稿", 1000 + DRAFT_TTL_MS - 1000);
    const later = 1000 + DRAFT_TTL_MS + 1;
    expect(loadDraft(s, "old", later)).toBeNull();
    saveDraft(s, "other", "触发清表", later);
    const table = parseDraftTable(s.getItem(DRAFTS_KEY));
    expect(table.old).toBeUndefined();
    expect(table.other).toBeDefined();
  });

  it("pruneDraftTable 纯函数：只清过期项", () => {
    const table: DraftTable = {
      a: { text: "a", updatedAt: 0 },
      b: { text: "b", updatedAt: 900 },
    };
    const pruned = pruneDraftTable(table, 1000, 500);
    expect(Object.keys(pruned)).toEqual(["b"]);
  });

  it("parseDraftTable 损坏 JSON/坏形状 → 空表，绝不 throw", () => {
    expect(parseDraftTable("{oops")).toEqual({});
    expect(parseDraftTable("[1,2]")).toEqual({});
    expect(parseDraftTable(null)).toEqual({});
    expect(parseDraftTable('{"s1":{"text":"","updatedAt":1}}')).toEqual({});
    expect(parseDraftTable('{"s1":{"text":"x","updatedAt":"bad"}}')).toEqual({});
  });

  it("存储不可用（getItem/setItem 抛异常）安全降级不 throw", () => {
    const bad = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(loadDraft(bad, "s1")).toBeNull();
    expect(() => saveDraft(bad, "s1", "x")).not.toThrow();
    expect(() => clearDraft(bad, "s1")).not.toThrow();
    expect(() => saveDraft(null, "s1", "x")).not.toThrow();
  });

  it("防抖时长常量存在（逐键落盘会掉帧，输入侧按此防抖）", () => {
    expect(DRAFT_SAVE_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(DRAFT_SAVE_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });
});
