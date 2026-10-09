/**
 * live tail 测试：非本进程会话的文件变化 → message_end 推送 + running/idle 状态推断。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerEvent } from "../types.js";
import { loadSessionMessages } from "../sessions/scan.js";
import { SessionHub } from "../sessions/hub.js";
import { inferExternalStatus, piMessageLoader, SessionTailManager, type MessageLoader } from "../sessions/tail.js";

const ts = () => new Date().toISOString();

function entry(id: string, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: ts(),
    message: { role, content: text },
  });
}

describe("tail: 文件追加 → message_end 推送 + 状态推断", () => {
  let dir: string;
  let file: string;
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-"));
    file = join(dir, "sess.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "tail-1", timestamp: ts(), cwd: "/tmp/demo" }),
        entry("m1", "user", "hello"),
        entry("m2", "assistant", "world"),
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquire 后文件追加的新消息被推送为 message_end，并推 running", async () => {
    const manager = new SessionTailManager((sessionId, event) => {
      events.push({ sessionId, event });
    });
    try {
      manager.acquire("tail-1", file);
      // 等初始快照完成
      await new Promise((r) => setTimeout(r, 300));

      await appendFile(file, `\n${entry("m3", "user", "new message")}`, "utf8");
      // 轮询间隔 2s + 余量
      await new Promise((r) => setTimeout(r, 2600));

      const ends = events.filter((e) => e.event.type === "message_end");
      assert.equal(ends.length, 1, `应推送 1 条 message_end，实际 ${ends.length}`);
      const msg = (ends[0].event as { message: { id: string; role: string } }).message;
      assert.equal(msg.id, "m3");
      assert.equal(msg.role, "user");

      const statuses = events.filter((e) => e.event.type === "status").map((e) => (e.event as { status: string }).status);
      assert.ok(statuses.includes("running"), `应推 running，实际 ${JSON.stringify(statuses)}`);
    } finally {
      manager.stopAll();
    }
  });

  it("release 后不再推送（ref 计数归零停止）", async () => {
    const before2 = events.length;
    const manager = new SessionTailManager((sessionId, event) => {
      events.push({ sessionId, event });
    });
    try {
      manager.acquire("tail-1", file);
      manager.acquire("tail-1", file);
      manager.release("tail-1");
      // 等初始快照完成再追加，否则新消息会被并入快照（测试时序，非实现问题）
      await new Promise((r) => setTimeout(r, 300));
      await appendFile(file, `\n${entry("m4", "assistant", "after release ref1")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      // ref 还有 1，应仍推送
      assert.ok(events.length > before2, "ref>0 时应继续推送");

      manager.release("tail-1"); // 归零停止
      const at = events.length;
      await appendFile(file, `\n${entry("m5", "user", "after stop")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(events.length, at, "停止后不应再推送");
    } finally {
      manager.stopAll();
    }
  });

  it("inferExternalStatus：60 秒内活动 = running（覆盖工具间思考间隙），否则 idle", () => {
    const now = Date.now();
    assert.equal(inferExternalStatus(now - 1000, now), "running");
    assert.equal(inferExternalStatus(now - 20_000, now), "running");
    assert.equal(inferExternalStatus(now - 70_000, now), "idle");
  });
});

describe("tail: detach 强制停（live 接管场景）", () => {
  it("detach 后不再推送，即使 ref 未归零", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail2-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "tail-2", timestamp: ts(), cwd: "/tmp/x" }) + "\n" + entry("n1", "user", "hi"), "utf8");
    const got: ServerEvent[] = [];
    const manager = new SessionTailManager((_sid, ev) => got.push(ev));
    try {
      manager.acquire("tail-2", file);
      manager.acquire("tail-2", file); // ref=2
      await new Promise((r) => setTimeout(r, 300));
      manager.detach("tail-2"); // 模拟会话转 live
      const at = got.length;
      await appendFile(file, `\n${entry("n2", "assistant", "should not appear")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(got.length, at, "detach 后不应再推送");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tail: 回复落盘后的短静默 → agent_settled（中止按钮及时消失）", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function setup(): Promise<{ dir: string; file: string; got: Array<{ sessionId: string; event: ServerEvent }>; manager: SessionTailManager }> {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail3-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "tail-3", timestamp: ts(), cwd: "/tmp/demo" }),
        entry("u1", "user", "帮我修构建"),
      ].join("\n"),
      "utf8",
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    // 注入小轮询/短静默窗口（生产默认 2s 轮询 / 3s 回复静默 / 60s 活动窗口）
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterReplyMs: 200,
      idleAfterMs: 60_000,
    });
    manager.acquire("tail-3", file);
    await sleep(250); // 初始快照
    return { dir, file, got, manager };
  }

  it("assistant 回复落盘 + 短静默 → agent_settled + status idle（不再等 60s）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("a1", "assistant", "构建修好了")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      assert.ok(types.includes("message_end"), `应推回复 message_end，实际 ${JSON.stringify(types)}`);
      assert.ok(types.includes("agent_settled"), `回复落盘短静默应推 agent_settled，实际 ${JSON.stringify(types)}`);
      // 顺序：agent_settled → status idle（与 SessionHub 一致）
      const settleAt = got.findIndex((e) => e.event.type === "agent_settled");
      const idleAt = got.findIndex((e) => e.event.type === "status" && (e.event as { status: string }).status === "idle");
      assert.ok(settleAt >= 0 && idleAt > settleAt, `顺序应为 settled→idle，实际 ${JSON.stringify(got.map((e) => e.event.type))}`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("user 消息落盘不走短静默（工具间思考仍用长窗口，不误判 idle）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("u2", "user", "继续")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      assert.ok(types.includes("message_end"));
      assert.ok(!types.includes("agent_settled"), `user 落盘不应触发短静默 settle，实际 ${JSON.stringify(types)}`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("回复落盘 settle 后新一轮落盘 → 重新 running 并可再次 settle（多段/多轮不卡死）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("a1", "assistant", "第一轮完成")}`, "utf8");
      await sleep(700);
      assert.equal(got.filter((e) => e.event.type === "agent_settled").length, 1);

      await appendFile(file, `\n${entry("a2", "assistant", "第二轮完成")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      const settled = types.filter((t) => t === "agent_settled").length;
      assert.equal(settled, 2, `两轮回复各自 settle，实际 ${JSON.stringify(types)}`);
      const lastRunning = types.lastIndexOf("status");
      assert.ok(lastRunning > types.indexOf("agent_settled"), "第二轮应重新推 running");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- OOM 审计 AC1：字节偏移增量解析 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 链式 entry（parentId 串链，active branch 才能覆盖全部消息，贴近真实 pi session 格式） */
function centry(id: string, parentId: string | null, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: ts(),
    message: { role, content: text },
  });
}

const endedIds = (events: Array<{ sessionId: string; event: ServerEvent }>): string[] =>
  events
    .filter((e) => e.event.type === "message_end")
    .map((e) => (e.event as unknown as { message: { id: string } }).message.id);

describe("tail: 字节偏移增量解析（AC1：不丢不重不错序）", () => {
  it("多轮追加 + 半行延后：每条恰好推送一次且保序，增量生效（全量 loader 零调用）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-inc-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "inc-1", timestamp: ts(), cwd: "/tmp/demo" }),
        centry("m1", null, "user", "初始消息"),
      ].join("\n") + "\n",
      "utf8",
    );
    // 计数 loader：全量解析调用计数 + 增量行计数（证明走字节偏移增量而非每轮全量重解析）
    let fullLoads = 0;
    let incrementalLines = 0;
    const loader: MessageLoader = Object.assign(
      async (f: string) => {
        fullLoads += 1;
        return loadSessionMessages(f);
      },
      {
        createIncremental: () => {
          const parser = piMessageLoader.createIncremental!();
          return {
            pushLine: (line: string) => {
              incrementalLines += 1;
              parser.pushLine(line);
            },
            messages: () => parser.messages(),
          };
        },
      },
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
    });
    try {
      manager.acquire("inc-1", file, loader);
      await sleep(300); // 初始快照
      assert.deepEqual(endedIds(got), [], "初始快照不推送");

      // 第一批：两条（appendFile 无尾换行的常见写盘形态）
      await appendFile(file, `\n${centry("m2", "m1", "user", "第二批-a")}\n${centry("m3", "m2", "assistant", "第二批-b")}`, "utf8");
      await sleep(400);
      assert.deepEqual(endedIds(got), ["m2", "m3"], "第一批不丢不重不错序");

      // 第二批：半行（写到一半）→ 留到下轮，不解析不推送
      const line4 = centry("m4", "m3", "user", "半行消息");
      await appendFile(file, `\n${line4.slice(0, 24)}`, "utf8");
      await sleep(400);
      assert.deepEqual(endedIds(got), ["m2", "m3"], "半行不解析不推送（留到下轮）");

      // 完成半行 + 再新增一条：恰好各推一次
      await appendFile(file, `${line4.slice(24)}\n${centry("m5", "m4", "assistant", "收尾")}`, "utf8");
      await sleep(400);
      assert.deepEqual(endedIds(got), ["m2", "m3", "m4", "m5"], "跨轮半行补齐后不丢不重不错序");

      assert.equal(fullLoads, 0, "增量路径不得触发全量解析（只解析新增字节行）");
      assert.ok(incrementalLines >= 4, `应只解析新增字节行，实际喂入 ${incrementalLines} 行`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("截断/原地重写 → 全量对账：历史消息不重推，新消息不丢", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-rewrite-"));
    const file = join(dir, "s.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "inc-2", timestamp: ts(), cwd: "/tmp/demo" });
    await writeFile(
      file,
      [
        header,
        centry("r1", null, "user", "旧消息-初始内容足够长AAAA"),
        centry("r2", "r1", "assistant", "旧回复-初始内容足够长BBBB"),
      ].join("\n") + "\n",
      "utf8",
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
    });
    try {
      manager.acquire("inc-2", file);
      await sleep(300);
      // 重写为更短内容（截断 + 新 id）：应回退全量对账
      await writeFile(file, [header, centry("r1", null, "user", "旧消息-初始内容足够长AAAA"), centry("r9", "r1", "user", "新")].join("\n") + "\n", "utf8");
      await sleep(400);
      assert.deepEqual(endedIds(got), ["r9"], "重写后只推新消息：历史 r1 不重推（knownIds 兜底）");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("无增量能力的注入 loader（claude 场景）安全回退全量解析，事件仍不丢不重", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-fallback-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "inc-3", timestamp: ts(), cwd: "/tmp/demo" }),
        centry("c1", null, "user", "claude 场景"),
      ].join("\n") + "\n",
      "utf8",
    );
    let loads = 0;
    const loader: MessageLoader = async (f: string) => {
      loads += 1;
      return loadSessionMessages(f);
    };
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
    });
    try {
      manager.acquire("inc-3", file, loader);
      await sleep(300);
      assert.equal(loads, 1, "初始快照全量解析一次");
      await appendFile(file, `\n${centry("c2", "c1", "assistant", "回退也增量正确")}`, "utf8");
      await sleep(400);
      assert.deepEqual(endedIds(got), ["c2"], "回退全量解析下事件仍不丢不重");
      assert.ok(loads >= 2, "无增量能力时按变更回退全量解析（行为与旧实现一致）");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 数据一致性审计：rewrite 检测 / 吞消息窗口 / 状态回写 / 全量回退熔断 ----------

describe("tail: 原地截断重写（SDK _rewriteFile 形态）→ 重建 parser，不错位不丢消息", () => {
  it("重写为更长内容（size > 已解析偏移）不再误判 append：两代数据不混排，新消息全量对账补推", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-rewrite2-"));
    const file = join(dir, "s.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "rw-1", timestamp: ts(), cwd: "/tmp/demo" });
    await writeFile(
      file,
      [
        header,
        centry("r1", null, "user", "旧消息-初始内容AAAA"),
        centry("r2", "r1", "assistant", "旧回复-初始内容BBBB"),
      ].join("\n") + "\n",
      "utf8",
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
    });
    try {
      manager.acquire("rw-1", file);
      await sleep(300); // 初始快照消费完旧内容
      // open "w" 截断重写为更长内容（与 SDK _rewriteFile 同形态）：旧实现按 append 错位读取，
      // 会把 r3 切成半行丢掉、只推错位后的行（两代数据混排）
      await writeFile(
        file,
        [
          header,
          centry("r1", null, "user", "旧消息-初始内容AAAA"),
          centry("r3", "r1", "assistant", `重写后新增的第一条-${"C".repeat(200)}`),
          centry("r4", "r3", "user", "重写后新增的第二条"),
        ].join("\n") + "\n",
        "utf8",
      );
      await sleep(400);
      assert.deepEqual(endedIds(got), ["r3", "r4"], "重写后全量对账：r1 不重推、r3/r4 不丢不错序");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tail: start 快照吞消息窗口（连接时刻后写入的消息照常推送）", () => {
  it("快照读取期间写入的新消息不得只记 knownIds 不推送（本连接 UI 永久缺消息）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-window-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [JSON.stringify({ type: "session", version: 3, id: "win-1", timestamp: ts(), cwd: "/tmp/demo" }), centry("m1", null, "user", "旧消息")].join("\n") + "\n",
      "utf8",
    );
    // 慢 loader：快照读取期间外部写入 → 新消息被包含进快照（复现吞消息窗口的确定性时序）
    const loader: MessageLoader = async (f: string) => {
      await sleep(150);
      return loadSessionMessages(f);
    };
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
    });
    try {
      manager.acquire("win-1", file, loader);
      await sleep(30); // start() 已取连接时刻 startedMs
      await appendFile(file, `\n${centry("m2", "m1", "assistant", "快照窗口内的新消息")}`, "utf8");
      await sleep(500);
      assert.deepEqual(endedIds(got), ["m2"], "快照中晚于连接时刻的消息照常推送（旧消息 m1 不重复推）");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tail: status 事件回写内存状态源（API/WS 不分叉）", () => {
  it("tail 推 running/idle 时同步回写 hub.statuses，getStatus 与 WS 显示同源", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-status-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [JSON.stringify({ type: "session", version: 3, id: "st-1", timestamp: ts(), cwd: "/tmp/demo" }), centry("u1", null, "user", "初始")].join("\n") + "\n",
      "utf8",
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const hub = new SessionHub(dir, (_sid, ev) => got.push({ sessionId: _sid, event: ev }));
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterReplyMs: 200,
      idleAfterMs: 60_000,
    });
    try {
      manager.acquire("st-1", file);
      await sleep(250);
      assert.equal(hub.getStatus("st-1"), "idle", "无活动时 API 状态 idle");
      // user 落盘不走短静默：持续 running（回写后 getStatus 必须是 running，不再是陈旧 idle）
      await appendFile(file, `\n${centry("u2", "u1", "user", "新任务来了")}`, "utf8");
      await sleep(400);
      assert.equal(hub.getStatus("st-1"), "running", "tail 推 running 时 API 状态同步回写");
      // assistant 回复落盘 + 短静默 → tail settle，API 状态同步回 idle
      await appendFile(file, `\n${centry("a1", "u2", "assistant", "干完了")}`, "utf8");
      await sleep(600);
      assert.equal(hub.getStatus("st-1"), "idle", "tail settle 后 API 状态同步回 idle");
    } finally {
      manager.stopAll();
      hub.disposeAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tail: 全量回退熔断（无增量能力 loader 的 CPU/内存防护）", () => {
  it("大文件阈值：熔断期间降频全量解析，消息延迟但不丢（pendingReparse 补推）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-fuse-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [JSON.stringify({ type: "session", version: 3, id: "fu-1", timestamp: ts(), cwd: "/tmp/demo" }), centry("f1", null, "user", "初始")].join("\n") + "\n",
      "utf8",
    );
    let loads = 0;
    const loader: MessageLoader = async (f: string) => {
      loads += 1;
      return loadSessionMessages(f);
    };
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    // 任何文件都算「大文件」（阈值 1 字节）+ 400ms 降频窗口，轮询 50ms
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 50,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
      fullReparseMaxBytes: 1,
      fullReparseMinIntervalMs: 400,
    });
    try {
      manager.acquire("fu-1", file, loader);
      await sleep(150); // 初始快照（loads=1，记为全量解析基准时刻）
      assert.equal(loads, 1, "初始快照全量解析一次");
      await appendFile(file, `\n${centry("f2", "f1", "user", "熔断期间的消息")}`, "utf8");
      await sleep(250); // 降频窗口内多轮 tick：不得每轮全量重解析
      assert.ok(loads <= 2, `熔断期间全量解析应降频，实际 loads=${loads}`);
      await sleep(600); // 窗口过后补解析（pendingReparse 补推）
      assert.deepEqual(endedIds(got), ["f2"], "熔断只降频不丢消息：窗口过后照常补推");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("高频变更（每轮都有写入）同样触发降频，消息最终完整推送", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-churn-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [JSON.stringify({ type: "session", version: 3, id: "ch-1", timestamp: ts(), cwd: "/tmp/demo" }), centry("h1", null, "user", "初始")].join("\n") + "\n",
      "utf8",
    );
    let loads = 0;
    const loader: MessageLoader = async (f: string) => {
      loads += 1;
      return loadSessionMessages(f);
    };
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 50,
      idleAfterMs: 60_000,
      idleAfterReplyMs: 60_000,
      fullReparseMaxBytes: 10 * 1024 * 1024, // 不走大小阈值：只测变化频率熔断
      fullReparseMinIntervalMs: 400,
    });
    try {
      manager.acquire("ch-1", file, loader);
      await sleep(150);
      // 持续写入 5 条（每 60ms 一条，覆盖多轮 tick → churn 熔断）
      for (let i = 2; i <= 6; i += 1) {
        await appendFile(file, `\n${centry(`h${i}`, `h${i - 1}`, "user", `持续写入-${i}`)}`, "utf8");
        await sleep(60);
      }
      await sleep(700); // 停止写入后窗口到达：剩余消息补推
      const ids = endedIds(got);
      for (let i = 2; i <= 6; i += 1) {
        assert.ok(ids.includes(`h${i}`), `h${i} 应最终推送（不丢），实际 ${JSON.stringify(ids)}`);
      }
      assert.equal(new Set(ids).size, ids.length, "不重复推送");
      assert.ok(loads < 8, `高频写入应降频全量解析，实际 loads=${loads}`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
