/**
 * 通知聚合（docs/API_CONTRACT.md §5）单测：
 * 会话事件/历史回填聚合、read 标记持久化、近重复折叠、merge 排序与截断。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  applyReadMarks,
  loadReadMarks,
  makeNotification,
  mergeNotifications,
  notificationId,
  parseReadMarks,
  saveReadMarks,
  seedNotificationsFromInsights,
  serializeReadMarks,
  unreadCountOf,
} from "../notifications.js";
import { DashboardService } from "../dashboard.js";
import { buildInsight, type SessionInsight } from "../sessions/scan.js";
import type { NotificationItem, SessionListItem } from "../types.js";

const T1 = "2026-02-18T11:00:00.000Z";
const T2 = "2026-02-18T10:00:00.000Z";
const T3 = "2026-02-17T09:00:00.000Z";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: "id-1",
    sessionId: "s-1",
    sessionName: "会话",
    kind: "settled",
    text: "完成",
    timestamp: T1,
    read: false,
    ...over,
  };
}

function makeInsight(status: SessionListItem["status"], lastRole: "user" | "assistant" | null): SessionInsight {
  const summary: SessionListItem = {
    id: `sess-${status}-${lastRole}`,
    name: `会话 ${status}`,
    cwd: "/tmp/demo",
    updatedAt: T1,
    messageCount: 2,
    status,
    lastUserMessage: "帮我跑",
    lastAssistantMessage: "跑完了",
    sessionFile: "/tmp/x.jsonl",
    source: "pi",
  };
  const built = buildInsight(summary, []);
  return { ...built, lastMessageRole: lastRole };
}

describe("notifications: 条目构造与 read 标记", () => {
  it("id 确定性（sessionId:kind:timestamp）——重启后 read 标记仍有效", () => {
    assert.equal(notificationId("s1", "settled", T1), "s1:settled:2026-02-18T11:00:00.000Z");
    const a = makeNotification({ sessionId: "s1", kind: "settled", text: "x", timestamp: T1 });
    const b = makeNotification({ sessionId: "s1", kind: "settled", text: "不同文本", timestamp: T1 });
    assert.equal(a.id, b.id);
  });

  it("文本摘要截断到 120 字符", () => {
    const n = makeNotification({ sessionId: "s1", kind: "error", text: "e".repeat(300), timestamp: T1 });
    assert.equal(n.text.length, 121); // 120 + 省略号
    assert.ok(n.text.endsWith("…"));
    assert.equal(n.read, false);
    assert.equal(n.sessionName, null);
  });

  it("applyReadMarks / unreadCountOf", () => {
    const items = [item({ id: "a" }), item({ id: "b", read: true }), item({ id: "c" })];
    const marked = applyReadMarks(items, new Set(["a"]));
    assert.deepEqual(marked.map((m) => m.read), [true, false, false]);
    assert.equal(unreadCountOf(marked), 2);
  });
});

describe("notifications: mergeNotifications", () => {
  it("按 id 去重（后者覆盖）、时间倒序、截断 maxItems", () => {
    const merged = mergeNotifications(
      [
        [item({ id: "a", timestamp: T2 }), item({ id: "b", timestamp: T3 })],
        [item({ id: "a", timestamp: T2, text: "更新后的文本" })],
      ],
      10,
    );
    assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
    assert.equal(merged[0].text, "更新后的文本");
    assert.equal(merged[0].timestamp, T2);

    const capped = mergeNotifications([[item({ id: "a", timestamp: T1 })], [item({ id: "b", timestamp: T2 })]], 1);
    assert.equal(capped.length, 1);
    assert.equal(capped[0].id, "a");
  });

  it("近重复折叠：同会话同类型且时间接近只留一条（文本更丰富者胜）", () => {
    // live 回报与重启后的历史回填是同一次事件：id 不同但应折叠
    const live = item({ id: "live-1", kind: "settled", text: "agent 已完成本轮工作", timestamp: T1 });
    const seeded = item({ id: "seed-1", kind: "settled", text: "构建已修复，测试全绿，可以合并了", timestamp: "2026-02-18T10:58:00.000Z" });
    const merged = mergeNotifications([[seeded], [live]]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].text, "构建已修复，测试全绿，可以合并了");
  });

  it("近重复折叠后 read 状态取已读优先（不重新变未读）", () => {
    const live = item({ id: "live-1", read: false, timestamp: T1 });
    const seeded = item({ id: "seed-1", read: true, timestamp: "2026-02-18T10:59:00.000Z" });
    const merged = mergeNotifications([[seeded], [live]]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].read, true);
  });

  it("不同类型/不同会话/时间相隔远的不折叠", () => {
    const merged = mergeNotifications([
      [
        item({ id: "a", kind: "settled", timestamp: T1 }),
        item({ id: "b", kind: "error", timestamp: T1 }),
        item({ id: "c", sessionId: "s-2", kind: "settled", timestamp: T1 }),
        item({ id: "d", kind: "settled", timestamp: T3 }),
      ],
    ]);
    assert.equal(merged.length, 4);
  });
});

describe("notifications: 历史回填（会话扫描 → 通知）", () => {
  it("error → kind=error；干完等输入 → kind=settled；运行中/等 agent 的不生成", () => {
    const seeded = seedNotificationsFromInsights([
      makeInsight("error", "assistant"),
      makeInsight("idle", "assistant"),
      makeInsight("running", "assistant"),
      makeInsight("idle", "user"),
    ]);
    const kinds = seeded.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["error", "settled"]);
    const settled = seeded.find((n) => n.kind === "settled");
    assert.equal(settled?.text, "跑完了");
    assert.equal(settled?.sessionName, "会话 idle");
    assert.equal(settled?.read, false);
  });
});

describe("notifications: read 标记文件持久化", () => {
  let dir: string;
  let file: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-notif-"));
    file = join(dir, "sub", "read-marks.json");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serialize/parse 往返", () => {
    assert.deepEqual(parseReadMarks(serializeReadMarks(["a", "b"])), ["a", "b"]);
    assert.deepEqual(parseReadMarks(null), []);
    assert.deepEqual(parseReadMarks(""), []);
    assert.deepEqual(parseReadMarks("{ broken"), []);
    assert.deepEqual(parseReadMarks('{"readIds": [1, "x"]}'), ["x"]);
  });

  it("save/load 往返（自动建目录）", async () => {
    await saveReadMarks(file, new Set(["n1", "n2"]));
    const loaded = await loadReadMarks(file);
    assert.deepEqual([...loaded].sort(), ["n1", "n2"]);
    const raw = await readFile(file, "utf8");
    assert.deepEqual(parseReadMarks(raw), ["n1", "n2"]);
  });

  it("缺失文件 → 空集合（不是错误）", async () => {
    const loaded = await loadReadMarks(join(dir, "nope.json"));
    assert.equal(loaded.size, 0);
  });
});

describe("notifications: DashboardService 通知流", () => {
  let dir: string;
  let storeFile: string;
  const NOW_MS = Date.parse("2026-02-18T12:00:00.000Z");

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-notif2-"));
    storeFile = join(dir, "read-marks.json");
    const enc = "--tmp-work-demo--";
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, enc), { recursive: true });
    await writeFile(
      join(dir, enc, "s1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "修复构建", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-02-18T10:05:00.000Z",
          message: { role: "assistant", content: "构建已修复", timestamp: Date.parse("2026-02-18T10:05:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(onNotification?: (n: NotificationItem) => void): DashboardService {
    return new DashboardService({
      sessionDir: dir,
      workspaceRoot: "/nonexistent-root-xyz",
      storeFile,
      now: () => NOW_MS,
      onNotification,
    });
  }

  it("listNotifications：历史回填 + live 事件聚合，未读数正确", async () => {
    const pushed: NotificationItem[] = [];
    const service = makeService((n) => pushed.push(n));

    // live：一轮完成（message_end 跟踪最后输出）+ 出错 + 插话 + 中止
    service.recordEvent("s2", {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: NOW_MS, text: "任务完成", toolCalls: [] },
    });
    service.recordEvent("s2", { type: "agent_settled" });
    service.recordEvent("s2", { type: "error", code: "PROMPT_FAILED", message: "模型调用失败" });
    service.recordActivity("s2", { kind: "steering", text: "收到插话：改用方案 B" });
    service.recordActivity("s2", { kind: "done", text: "已手动中止本轮运行" });

    assert.equal(pushed.length, 4); // settled/error/steering/done 各一条
    const pushedKinds = pushed.map((n) => n.kind).sort();
    assert.deepEqual(pushedKinds, ["done", "error", "settled", "steering"]);

    const { notifications, unreadCount } = await service.listNotifications();
    // 历史回填 1 条（s1 settled）+ live 4 条
    assert.equal(notifications.length, 5);
    assert.equal(unreadCount, 5);
    // 时间倒序
    for (let i = 1; i < notifications.length; i += 1) {
      assert.ok(Date.parse(notifications[i - 1].timestamp) >= Date.parse(notifications[i].timestamp));
    }
    // live settled 的文本取 message_end 跟踪到的最后输出
    const settled = notifications.find((n) => n.kind === "settled" && n.sessionId === "s2");
    assert.equal(settled?.text, "任务完成");
    // 历史回填带会话名
    const seeded = notifications.find((n) => n.sessionId === "s1");
    assert.equal(seeded?.sessionName, null); // s1 无 name
    assert.equal(seeded?.text, "构建已修复");
  });

  it("markAllRead 后未读清零，且重启（新实例）仍保持已读", async () => {
    const service = makeService();
    await service.markAllRead();
    const afterRead = await service.listNotifications();
    assert.equal(afterRead.unreadCount, 0);
    assert.ok(afterRead.notifications.every((n) => n.read));

    // 新实例（模拟重启）：read 标记从文件恢复
    const restarted = makeService();
    const persisted = await restarted.listNotifications();
    assert.equal(persisted.unreadCount, 0);
  });

  it("重启后新增事件仍为未读", async () => {
    const restarted = makeService();
    restarted.recordActivity("s3", { kind: "done", text: "已手动中止本轮运行" });
    const { notifications, unreadCount } = await restarted.listNotifications();
    assert.equal(unreadCount, 1);
    assert.equal(notifications.find((n) => n.sessionId === "s3")?.read, false);
  });
});
