/**
 * 会话状态推断回归测试（bug：新建会话进 chat 页显示「思考中」+ 停止按钮）：
 * 根因 = statusWithInference 丢弃显式 idle 走时间推断，而新建会话文件 mtime=now
 * 必然命中 inferExternalStatus 的 60s 窗口 → 误判 running。
 * - 新建会话（0 消息）立即查询必须 idle，不被时间推断误判
 * - 显式 idle 在 sweep 后仍保留（不再秒清，防 30s 后复现）
 * - 无本进程记录的外部会话仍按文件活动推断 running（原行为不破坏）
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionHub } from "../sessions/hub.js";
import { encodeCwdDirName, sessionFileName } from "../sessions/scan.js";
import type { ServerEvent } from "../types.js";

describe("会话状态推断：显式 idle 优先于时间推断", () => {
  let root: string;
  let sessionDir: string;
  let workDir: string;
  let hub: SessionHub;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-status-"));
    sessionDir = join(root, "sessions");
    workDir = join(root, "work");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    hub = new SessionHub(sessionDir, (_id: string, _event: ServerEvent) => undefined);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("新建会话（0 消息）立即查询 = idle，不被 60s 时间窗口误判 running", async () => {
    const created = await hub.createSession(workDir, "");
    assert.equal(created.status, "idle");

    // findSession（chat 页 loadSession 走此路径）：文件 mtime=now，修复前误判 running
    const found = await hub.findSession(created.id);
    assert.ok(found, "新建会话应可查到");
    assert.equal(found.status, "idle");

    // statusFor（dashboard 统计用）同样不得误判
    assert.equal(hub.statusFor(created.id, Date.parse(found.updatedAt)), "idle");
  });

  it("sweep 后显式 idle 记录仍保留（修复前秒清 → 30s 后复现误判）", async () => {
    const created = await hub.createSession(workDir, "sweep 用例");
    hub.sweep(); // 模拟周期清扫
    const found = await hub.findSession(created.id);
    assert.equal(found?.status, "idle");
  });

  it("无本进程记录的外部会话：仍按文件活动推断（recent=running / 老文件=idle）", async () => {
    const dir = join(sessionDir, encodeURIComponent(workDir));
    await mkdir(dir, { recursive: true });
    const id = "a".repeat(32);
    const now = new Date().toISOString();
    await writeFile(
      join(dir, `${now}-${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: workDir })}\n`
      + `${JSON.stringify({ type: "user", id: "b".repeat(32), parentId: null, timestamp: now, text: "hi" })}\n`,
      "utf8",
    );
    // 外部 CLI 会话（hub 无 statuses 记录）：新鲜活动 = running（覆盖工具间思考间隙的既有设计）
    assert.equal(hub.statusFor(id, Date.now()), "running");
    // 静默超过 60s = idle
    assert.equal(hub.statusFor(id, Date.now() - 70_000), "idle");
  });

  it("fork 产生的新会话（文件 mtime=now）同样显式登记 idle，不被时间推断误判 running", async () => {
    // 纯 header 空会话（不带 name）：走 forkFrom 复制路径（带 name 的空会话见下一条回归用例）
    const created = await hub.createSession(workDir, "");
    const forked = await hub.forkSession(created.id);
    assert.equal(forked.status, "idle");

    const found = await hub.findSession(forked.id);
    assert.ok(found, "fork 会话应可查到");
    assert.equal(found.status, "idle");

    // statusFor（dashboard 统计用）同样不得误判
    assert.equal(hub.statusFor(forked.id, Date.parse(found.updatedAt)), "idle");
  });

  it("带 name 的空会话 fork 成功（回归：session_info 曾被当消息 leaf → 产出无 header 文件 → 500）", async () => {
    const created = await hub.createSession(workDir, "带名字的空会话");
    const forked = await hub.forkSession(created.id); // 修复前抛「会话复制后未能读回新会话」
    assert.equal(forked.name, "带名字的空会话", "name 应随 fork 继承");

    const found = await hub.findSession(forked.id);
    assert.ok(found, "fork 出的新会话必须文件完整可读回");
    assert.equal(found.status, "idle");
    assert.equal(forked.messageCount, 0, "空会话 fork 后仍是 0 消息");
  });

  it("消息后改名（session_info 为最后一个 entry）fork 正常：meta 叶子沿 parentId 回溯，不丢消息", async () => {
    const dir = join(sessionDir, encodeCwdDirName(workDir));
    await mkdir(dir, { recursive: true });
    const id = "c".repeat(32);
    const now = new Date().toISOString();
    await writeFile(
      join(dir, sessionFileName(now, id)),
      JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: workDir }) + "\n"
        + JSON.stringify({ type: "message", id: "d".repeat(8), parentId: null, timestamp: now, message: { role: "user", content: "hi" } }) + "\n"
        + JSON.stringify({ type: "session_info", id: "e".repeat(8), parentId: null, timestamp: now, name: "改名后的会话" }) + "\n",
      "utf8",
    );
    hub.invalidateList(); // 手写 fixture 后失效清单缓存，否则 findSession 走 TTL 缓存找不到
    const forked = await hub.forkSession(id);
    assert.equal(forked.name, "改名后的会话");
    const found = await hub.findSession(forked.id);
    assert.ok(found, "fork 出的新会话必须可读回");
    assert.equal(forked.messageCount, 1, "原会话消息必须完整保留");
  });
});
