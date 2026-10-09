/**
 * 会话改名回归测试（pi 源，SessionHub.renameSession）：
 * - renameSession 追加 session_info entry（append-only）：改名立即可见（invalidateList）、
 *   空串 = 显式清空名字、不存在 → 404
 * - ⚠️ mtime 陷阱回归（与 hub-status.test.ts 同根因）：改名写盘把文件 mtime 刷成 now，
 *   不登记会被 inferExternalStatus 的 60s 时间窗误判 running（改名后卡片/聊天页误显示
 *   「工作中/思考中」）——改名瞬间的推断状态快照显式登记进 statuses，不改变真实状态。
 */
import { strict as assert } from "node:assert";
import { appendFile, utimes, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionHub } from "../sessions/hub.js";
import { encodeCwdDirName, sessionFileName } from "../sessions/scan.js";
import type { ServerEvent } from "../types.js";

describe("会话改名（pi）：session_info entry + mtime 陷阱回归", () => {
  let root: string;
  let sessionDir: string;
  let workDir: string;
  let hub: SessionHub;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-rename-"));
    sessionDir = join(root, "sessions");
    workDir = join(root, "work");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    hub = new SessionHub(sessionDir, (_id: string, _event: ServerEvent) => undefined);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("改名追加 session_info entry，列表立即可见新名（不等 TTL）", async () => {
    const created = await hub.createSession(workDir, "旧名字");
    const renamed = await hub.renameSession(created.id, "新名字");
    assert.equal(renamed.name, "新名字");

    // renameSession 内部 invalidateList：findSession 立即读到新名
    const found = await hub.findSession(created.id);
    assert.ok(found, "会话应可查到");
    assert.equal(found.name, "新名字");

    // 多次改名为最新一条胜出
    await hub.renameSession(created.id, "再改一次");
    assert.equal((await hub.findSession(created.id))?.name, "再改一次");
  });

  it("空串清空名字（显式清空为 null）", async () => {
    const created = await hub.createSession(workDir, "要被清掉的名字");
    const renamed = await hub.renameSession(created.id, "");
    assert.equal(renamed.name, null);
    assert.equal((await hub.findSession(created.id))?.name, null);
  });

  it("改名会话不存在 → SESSION_NOT_FOUND(404)", async () => {
    await assert.rejects(
      () => hub.renameSession("f".repeat(32), "x"),
      (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
    );
  });

  it("mtime 陷阱回归：改名写盘刷新 mtime 后不被 60s 时间窗误判 running", async () => {
    const created = await hub.createSession(workDir, "待改名");
    const renamed = await hub.renameSession(created.id, "改名后的会话");
    // 改名瞬间的推断状态快照显式登记：返回值与后续查询都必须是 idle
    assert.equal(renamed.status, "idle", "改名后不得误判 running");

    const found = await hub.findSession(created.id);
    assert.ok(found);
    assert.equal(found.status, "idle");
    // statusFor（dashboard 统计用）同样不得误判
    assert.equal(hub.statusFor(created.id, Date.parse(found.updatedAt)), "idle");
  });

  it("mtime 陷阱回归：外部静默会话（无本进程记录、文件老）改名后仍 idle", async () => {
    const dir = join(sessionDir, encodeCwdDirName(workDir));
    await mkdir(dir, { recursive: true });
    const id = "a".repeat(32);
    const oldIso = new Date(Date.now() - 70_000).toISOString();
    const file = join(dir, sessionFileName(oldIso, id));
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: oldIso, cwd: workDir })}\n`
        + `${JSON.stringify({ type: "user", id: "b".repeat(32), parentId: null, timestamp: oldIso, text: "hi" })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 70_000);
    await utimes(file, old, old); // mtime 同步拨老：改名前推断必须是 idle
    hub.invalidateList(); // 手写 fixture 后失效清单缓存

    const renamed = await hub.renameSession(id, "外部会话改名");
    assert.equal(renamed.status, "idle", "改名前推断 idle，写盘刷新 mtime 后不得翻成 running");
    const found = await hub.findSession(id);
    assert.ok(found);
    assert.equal(found.name, "外部会话改名");
    assert.equal(hub.statusFor(id, Date.parse(found.updatedAt)), "idle");
  });

  it("改名瞬间为外部 running 的会话：快照登记不改变真实状态（仍 running）", async () => {
    const dir = join(sessionDir, encodeCwdDirName(workDir));
    const id = "c".repeat(32);
    const now = new Date().toISOString();
    await writeFile(
      join(dir, sessionFileName(now, id)),
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: workDir })}\n`
        + `${JSON.stringify({ type: "user", id: "d".repeat(32), parentId: null, timestamp: now, text: "hi" })}\n`,
      "utf8",
    );
    hub.invalidateList();
    const renamed = await hub.renameSession(id, "活跃会话改名");
    assert.equal(renamed.name, "活跃会话改名");
    assert.equal(renamed.status, "running", "改名前文件活动新鲜（running 推断），改名不得翻成 idle");
  });

  it("rename 状态快照用实时 mtime 现算：listCache 陈旧不得把真实 running 错误快照成 idle（竞态回归）", async () => {
    const dir = join(sessionDir, encodeCwdDirName(workDir));
    await mkdir(dir, { recursive: true });
    const id = "e".repeat(32);
    const oldIso = new Date(Date.now() - 70_000).toISOString();
    const file = join(dir, sessionFileName(oldIso, id));
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: oldIso, cwd: workDir })}\n`
        + `${JSON.stringify({ type: "message", id: "f".repeat(32), parentId: null, timestamp: oldIso, message: { role: "user", content: "hi" } })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 70_000);
    await utimes(file, old, old);
    hub.invalidateList();
    const cached = await hub.findSession(id); // 建立 listCache（此刻文件老，缓存里 updatedAt 旧）
    assert.ok(cached);
    assert.equal(cached.status, "idle");
    // 外部会话开始持续写入（真实 running），但 listCache 未失效（≤5s 陈旧窗口竞态）
    await appendFile(
      file,
      `\n${JSON.stringify({ type: "message", id: "0".repeat(32), parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: "外部新输出" } })}\n`,
      "utf8",
    );
    const renamed = await hub.renameSession(id, "竞态改名");
    assert.equal(renamed.status, "running", "快照必须基于写盘前实时 mtime：不得用陈旧缓存压制真实 running");
  });
});
