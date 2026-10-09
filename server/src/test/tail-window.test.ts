/**
 * tail 内存窗口化回归（OOM 审计 P2-2）：
 * - PiIncrementalParser entries 窗口化：条数/字节双上限，窗口外旧链出窗即弃（至少保 1 条）；
 *   窗口内消息与全量解析同 id 同序。
 * - knownIds 环形上限：FIFO 逐出，驻留数永不超过上限；窗口内不重复（不重推）、不丢新消息。
 * - 全量回退（claude/codex 无增量能力）只对账最近 messageWindow 条：窗口内 id 必在环内，跨 tick 无重复。
 * 独立成档（不改 tail.test.ts），轮询间隔注入小值快速驱动。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadSessionMessages } from "../sessions/scan.js";
import {
  PiIncrementalParser,
  SessionTailManager,
  DEFAULT_ENTRY_WINDOW,
  DEFAULT_KNOWN_IDS_MAX,
  type MessageLoader,
} from "../sessions/tail.js";
import type { ServerEvent } from "../types.js";

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 链式 entry（parentId 串成树，selectActiveBranch 走全链） */
function chainEntry(id: string, parentId: string | null, text: string, timestamp = ts()): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
  });
}

describe("PiIncrementalParser：entries 窗口化（P2-2）", () => {
  const header = JSON.stringify({ type: "session", version: 3, id: "p1", timestamp: ts(), cwd: "/tmp/demo" });

  it("条数窗口：只留最近 N 条，窗口内消息与全量解析同 id 同序", () => {
    const parser = new PiIncrementalParser({ maxEntries: 3 });
    parser.pushLine(header);
    let prev: string | null = null;
    for (let i = 1; i <= 10; i += 1) {
      parser.pushLine(chainEntry(`m${i}`, prev, `t${i}`));
      prev = `m${i}`;
    }
    const ids = parser.messages().map((m) => m.id);
    assert.deepEqual(ids, ["m8", "m9", "m10"], "窗口外旧链出窗即弃，只留最近 3 条");
  });

  it("默认窗口下与全量解析同 id 同序（语义不变性）", () => {
    const parser = new PiIncrementalParser();
    parser.pushLine(header);
    let prev: string | null = null;
    for (let i = 1; i <= 50; i += 1) {
      parser.pushLine(chainEntry(`m${i}`, prev, `t${i}`));
      prev = `m${i}`;
    }
    assert.deepEqual(
      parser.messages().map((m) => m.id),
      Array.from({ length: 50 }, (_, i) => `m${i + 1}`),
    );
  });

  it("字节窗口：超限逐出最旧（条数未超也裁）", () => {
    const parser = new PiIncrementalParser({ maxBytes: 300 });
    parser.pushLine(header);
    let prev: string | null = null;
    for (let i = 1; i <= 5; i += 1) {
      parser.pushLine(chainEntry(`m${i}`, prev, "x".repeat(120)));
      prev = `m${i}`;
    }
    const ids = parser.messages().map((m) => m.id);
    assert.ok(ids.length < 5, `应被字节窗口裁剪，实际 ${JSON.stringify(ids)}`);
    assert.equal(ids[ids.length - 1], "m5", "最新一条永远保留");
  });

  it("边界：单条 entry 超字节窗口也至少保留 1 条（最新消息不被裁空）", () => {
    const parser = new PiIncrementalParser({ maxBytes: 10 });
    parser.pushLine(header);
    parser.pushLine(chainEntry("big", null, "y".repeat(5000)));
    const ids = parser.messages().map((m) => m.id);
    assert.deepEqual(ids, ["big"]);
  });

  it("header 行不进 entries（同 parseSessionJsonl 口径）", () => {
    const parser = new PiIncrementalParser();
    parser.pushLine(header);
    parser.pushLine(chainEntry("only", null, "hi"));
    assert.deepEqual(parser.messages().map((m) => m.id), ["only"]);
  });
});

describe("tail：knownIds 环形上限 + 窗口内不重复（P2-2）", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-window-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("增量路径：持续追加下 knownIds 驻留数不超上限、无重复、不丢新消息", async () => {
    const file = join(dir, "inc.jsonl");
    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "w1", timestamp: ts(), cwd: "/tmp/demo" })];
    let prev: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const id = `i${i}`;
      lines.push(chainEntry(id, prev, `t${i}`));
      prev = id;
    }
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const events: ServerEvent[] = [];
    const manager = new SessionTailManager((_sid, ev) => events.push(ev), {
      pollMs: 50,
      idleAfterMs: 60_000,
      knownIdsMax: 32,
      entryWindow: 8,
    });
    try {
      manager.acquire("w1", file);
      await sleep(200); // 初始快照
      // 10 轮 × 5 条 = 50 条新链式 entry（远超 knownIdsMax=32）
      let lastId = prev as string;
      for (let round = 0; round < 10; round += 1) {
        const batch: string[] = [];
        for (let j = 0; j < 5; j += 1) {
          const id = `r${round}-${j}`;
          batch.push(chainEntry(id, lastId, "x"));
          lastId = id;
        }
        await appendFile(file, "\n" + batch.join("\n"), "utf8");
        await sleep(120);
      }
      const endedIds = events
        .filter((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end")
        .map((e) => e.message.id);
      assert.equal(new Set(endedIds).size, endedIds.length, "窗口内不重复（无重推）");
      assert.ok(endedIds.includes(lastId), `最新消息必须推送（不丢），实际尾部 ${JSON.stringify(endedIds.slice(-5))}`);
      const known = manager.knownIdCount("w1");
      assert.ok(known <= 32, `knownIds 驻留 ${known} 超上限 32`);
      assert.ok(known > 0);
    } finally {
      manager.stopAll();
    }
  });

  it("全量回退（无增量 loader）：只对账消息窗口，跨 tick 无重复、新消息照推", async () => {
    const file = join(dir, "full.jsonl");
    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "w2", timestamp: ts(), cwd: "/tmp/demo" })];
    let prev: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const id = `f${i}`;
      lines.push(chainEntry(id, prev, `t${i}`));
      prev = id;
    }
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const loader: MessageLoader = (f: string) => loadSessionMessages(f); // 无 createIncremental → 全量回退
    const events: ServerEvent[] = [];
    const manager = new SessionTailManager((_sid, ev) => events.push(ev), {
      pollMs: 50,
      idleAfterMs: 60_000,
      messageWindow: 10,
      knownIdsMax: 20,
      fullReparseMinIntervalMs: 0, // 关熔断降频：测试快速多轮追加
    });
    try {
      manager.acquire("w2", file, loader);
      await sleep(200); // 初始快照（历史消息不重推）
      let lastId = prev as string;
      const appended: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        const batch: string[] = [];
        for (let j = 0; j < 3; j += 1) {
          const id = `n${round}-${j}`;
          batch.push(chainEntry(id, lastId, "x"));
          appended.push(id);
          lastId = id;
        }
        await appendFile(file, "\n" + batch.join("\n"), "utf8");
        await sleep(150);
      }
      const endedIds = events
        .filter((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end")
        .map((e) => e.message.id);
      assert.equal(new Set(endedIds).size, endedIds.length, "全量回退跨 tick 无重复（knownIds 环内去重）");
      assert.deepEqual(endedIds, appended, "9 条新消息逐条照推（不丢不错序）");
      assert.ok(manager.knownIdCount("w2") <= 20, `knownIds 驻留 ${manager.knownIdCount("w2")} 超上限 20`);
    } finally {
      manager.stopAll();
    }
  });

  it("边界：knownIdsMax 压到最小也守「窗口内不重复」（环容量 ≥ 消息窗口的鉗制）", async () => {
    const file = join(dir, "edge.jsonl");
    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "w3", timestamp: ts(), cwd: "/tmp/demo" })];
    let prev: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const id = `e${i}`;
      lines.push(chainEntry(id, prev, `t${i}`));
      prev = id;
    }
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const events: ServerEvent[] = [];
    const manager = new SessionTailManager((_sid, ev) => events.push(ev), {
      pollMs: 40,
      idleAfterMs: 60_000,
      knownIdsMax: 16,
      entryWindow: 9999, // 高于环容量 → 构造时鉗制到 16
    });
    try {
      manager.acquire("w3", file);
      await sleep(150);
      let lastId = prev as string;
      for (let round = 0; round < 6; round += 1) {
        const batch: string[] = [];
        for (let j = 0; j < 4; j += 1) {
          const id = `x${round}-${j}`;
          batch.push(chainEntry(id, lastId, "x"));
          lastId = id;
        }
        await appendFile(file, "\n" + batch.join("\n"), "utf8");
        await sleep(100);
      }
      const endedIds = events
        .filter((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end")
        .map((e) => e.message.id);
      assert.equal(new Set(endedIds).size, endedIds.length, "极小环也不重推（鉗制保证窗口 id 在环内）");
      assert.ok(endedIds.includes(lastId), "最新消息不丢");
      assert.ok(manager.knownIdCount("w3") <= 16, `knownIds 驻留 ${manager.knownIdCount("w3")} 超上限 16`);
    } finally {
      manager.stopAll();
    }
  });

  it("默认常量口径：环容量 ≥ entry 窗口 × 2（窗口内 id 必在环内的设计前提）", () => {
    assert.ok(DEFAULT_KNOWN_IDS_MAX >= DEFAULT_ENTRY_WINDOW * 2);
    assert.ok(DEFAULT_ENTRY_WINDOW > 0);
    assert.ok(DEFAULT_KNOWN_IDS_MAX > 0);
  });
});
