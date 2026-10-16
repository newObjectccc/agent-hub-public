/**
 * 扩展轮询活性（responsive）测试 —— 「假接管」根治线。
 *
 * 修复前的问题（真机踩坑）：心跳 TTL 是 90s，用户关掉电脑终端后的整整 90s 里
 * `isOnline` 仍为 true → 前端 `attachDefaultWorthy` 判定可自动接管 → attach「成功」并提示
 * “终端在线，已默认接管终端” → 消息入队却没人取（扩展随终端进程一起没了）→
 * 用户等 60s 才看到一条小字提示，再等 detach 把指令取消，而那条消息**既不入离线队列
 * 也不回落平行模式**，输入框已清空 → 文本彻底消失，得重打。
 *
 * 长轮询上限是 30s（MAX_POLL_WAIT_MS），扩展活着就必然每 ≤30s 来一次，所以 poll 活性
 * 是比心跳硬得多的信号。POLL_TTL_MS = 45s（30s + 容差）。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AgentCommandHub, HEARTBEAT_TTL_MS, POLL_TTL_MS } from "../agents.js";
import { ErrorCodes, HubError } from "../errors.js";

function makeHub(): AgentCommandHub {
  return new AgentCommandHub(() => undefined);
}

describe("AgentCommandHub: 轮询活性（responsive）", () => {
  it("从未 poll 过 → 宽容判活（兼容扩展刚启动 / 老版本扩展，不得误拒接管）", () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    assert.equal(hub.isResponsive("s1", t0 + 1000), true);
    assert.deepEqual(hub.statusFor("s1", t0 + 1000), { online: true, attached: false, responsive: true });
    // 这种状态下 attach 必须成功（否则刚启动的扩展永远接管不了）
    assert.doesNotThrow(() => hub.attach("s1", t0 + 1000));
  });

  it("poll 过且新鲜 → 判活", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    await hub.poll("s1", 0, t0);
    assert.equal(hub.isResponsive("s1", t0 + POLL_TTL_MS - 1000), true);
  });

  it("poll 过但已陈旧 → 判死（终端进程大概率已退出）", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    await hub.poll("s1", 0, t0);
    assert.equal(hub.isResponsive("s1", t0 + POLL_TTL_MS + 1), false);
    assert.deepEqual(hub.statusFor("s1", t0 + POLL_TTL_MS + 1).responsive, false);
  });

  it("核心场景：心跳还在（90s 内）但扩展停止轮询 → attach 立即 409，不给假接管", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    await hub.poll("s1", 0, t0); // 终端活着时 poll 过
    // 46s 后：心跳仍在 90s TTL 内（isOnline=true），但 poll 已超 45s 窗口
    const t = t0 + 46_000;
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t - 40_000);
    assert.equal(hub.isOnline("s1", t), true, "前置：心跳口径下仍算在线（这正是旧行为的坑）");
    assert.equal(hub.isResponsive("s1", t), false);
    try {
      hub.attach("s1", t);
    } catch (err) {
      assert.ok(err instanceof HubError);
      assert.equal(err.code, ErrorCodes.ATTACH_UNAVAILABLE);
      assert.equal(err.statusCode, 409);
      // 文案必须给出路（重开终端 / 改用平行），不能只说“不可用”
      assert.match(err.message, /平行|重新打开/);
      return;
    }
    assert.fail("心跳在但扩展已停轮询时必须拒绝 attach（否则就是假接管）");
  });

  it("attach 之后终端才关闭 → enqueue 快速失败且不吞消息（文案明说没发出去）", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    await hub.poll("s1", 0, t0);
    hub.attach("s1", t0 + 10);
    assert.equal(hub.isAttached("s1", t0 + 10), true);

    // 终端关闭：心跳尚未过期（仍 attached），但 poll 已陈旧
    const t = t0 + POLL_TTL_MS + 5_000;
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t - 10_000);
    try {
      hub.enqueue("s1", { text: "重要消息", mode: "prompt" }, t);
    } catch (err) {
      assert.ok(err instanceof HubError);
      assert.equal(err.code, ErrorCodes.ATTACH_UNAVAILABLE);
      // 用户最怕的是「以为发出去了其实没有」：文案必须明确
      assert.match(err.message, /没有发出去/);
      // 且不得入队（前端要能原样重发/退回离线队列）
      assert.equal(hub.isAttached("s1", t), true, "attach 状态本身由心跳/sweep 管，这里只拒投递");
      return;
    }
    assert.fail("扩展停止轮询后 enqueue 必须立即失败，不能让消息在队列里干等 30s×3 重投");
  });

  it("恢复轮询后立即自愈（终端重开 / 网络恢复都能马上接管）", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    await hub.poll("s1", 0, t0);
    const stale = t0 + POLL_TTL_MS + 1;
    assert.equal(hub.isResponsive("s1", stale), false);
    await hub.poll("s1", 0, stale); // 扩展又来轮询了
    assert.equal(hub.isResponsive("s1", stale + 1), true);
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, stale);
    assert.doesNotThrow(() => hub.attach("s1", stale + 1));
  });

  it("sweep 淘汰陈旧的 poll 打点（防无界增长），且不影响心跳判定", async () => {
    const hub = makeHub();
    const t0 = Date.now();
    hub.heartbeat({ sessionId: "s1", pid: 1, cwd: "/tmp/x", capabilities: [] }, t0);
    await hub.poll("s1", 0, t0);
    const far = t0 + HEARTBEAT_TTL_MS * 5;
    hub.sweep(far);
    // 打点被淘汰后回到「从未 poll 过」的宽容态；心跳同样过期 → online=false
    assert.equal(hub.isOnline("s1", far), false);
    assert.equal(hub.isResponsive("s1", far), true);
  });
});
