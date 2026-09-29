/**
 * 通知列表纯函数单测：未读语义（done 不计未读）、子代理聚合、主会话置顶。
 */
import { describe, expect, it } from "vitest";
import type { NotificationItem } from "../api/types";
import { aggregateNotifications, countsAsUnread, unreadCountOf } from "./notifications";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: "n-1",
    sessionId: "s-1",
    sessionName: "主会话",
    kind: "settled",
    text: "已完成：修复构建",
    timestamp: "2026-02-18T11:00:00.000Z",
    read: false,
    ...over,
  };
}

describe("countsAsUnread / unreadCountOf（角标数 = 列表未读数 = 点击后递减）", () => {
  it("未读未标记 = 未读；已读不计", () => {
    expect(countsAsUnread(item({}))).toBe(true);
    expect(countsAsUnread(item({ read: true }))).toBe(false);
  });

  it("kind=done（已手动中止）不计未读（噪声回执不是待办）", () => {
    expect(countsAsUnread(item({ kind: "done" }))).toBe(false);
    expect(countsAsUnread(item({ kind: "done", read: true }))).toBe(false);
    // 其余 kind 正常计
    expect(countsAsUnread(item({ kind: "error" }))).toBe(true);
    expect(countsAsUnread(item({ kind: "steering" }))).toBe(true);
  });

  it("unreadCountOf 与逐条 countsAsUnread 一致；点击已读后递减", () => {
    const items = [
      item({ id: "a" }),
      item({ id: "b", kind: "done" }),
      item({ id: "c", read: true }),
      item({ id: "d", kind: "error" }),
    ];
    expect(unreadCountOf(items)).toBe(2);
    // 模拟点击条目 d 标记已读 → 角标 2→1
    const after = items.map((n) => (n.id === "d" ? { ...n, read: true } : n));
    expect(unreadCountOf(after)).toBe(1);
  });
});

describe("aggregateNotifications（子代理聚合）", () => {
  it("主会话通知在前（时间倒序），子代理 settled/steering/done 聚合为最后一条", () => {
    const rows = aggregateNotifications([
      item({ id: "sub-1", sessionId: "developer#1", isSubAgent: true, timestamp: "2026-02-18T11:30:00.000Z" }),
      item({ id: "main-1", timestamp: "2026-02-18T11:20:00.000Z" }),
      item({
        id: "sub-2",
        sessionId: "acceptance-reviewer#2",
        isSubAgent: true,
        kind: "steering",
        timestamp: "2026-02-18T11:25:00.000Z",
      }),
      item({ id: "main-2", timestamp: "2026-02-18T10:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "subAgents"]);
    const mainIds = rows.filter((r) => r.type === "item").map((r) => (r as { item: NotificationItem }).item.id);
    expect(mainIds).toEqual(["main-1", "main-2"]);
    const group = rows[2] as Extract<(typeof rows)[number], { type: "subAgents" }>;
    expect(group.items.map((n) => n.id)).toEqual(["sub-1", "sub-2"]);
    expect(group.unread).toBe(2);
  });

  it("子代理 error 独立显示不进聚合（错误不能被淹没）", () => {
    const rows = aggregateNotifications([
      item({ id: "sub-e", isSubAgent: true, kind: "error" }),
      item({ id: "sub-s", isSubAgent: true }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["item", "subAgents"]);
    const first = rows[0] as Extract<(typeof rows)[number], { type: "item" }>;
    expect(first.item.id).toBe("sub-e");
  });

  it("无子代理通知时不产生聚合行；组内未读只计未读项", () => {
    const rows = aggregateNotifications([item({ id: "a" }), item({ id: "b", kind: "done", isSubAgent: true })]);
    // done 子代理仍进聚合（噪声合并），但不计未读
    expect(rows.map((r) => r.type)).toEqual(["item", "subAgents"]);
    const group = rows[1] as Extract<(typeof rows)[number], { type: "subAgents" }>;
    expect(group.unread).toBe(0);

    const plain = aggregateNotifications([item({ id: "a" })]);
    expect(plain.map((r) => r.type)).toEqual(["item"]);
  });
});
