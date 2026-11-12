/**
 * InjectHub 单测（终端注入接管注册表，docs/TERMINAL_INJECT.md）：
 * attach 三态语义（注入接管 / 无通道拒绝 / 无 TUI 留给路由落后台）、发送重发现与
 * target-gone 降级信号、detach 幂等与 attach_state 事件、statusFor 形态。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InjectHub } from "../adapters/inject-hub.js";
import type { HostDiscovery } from "../adapters/terminal-host.js";
import type { ServerEvent } from "../types.js";

const KITTY_HOST = { kind: "kitty", socket: "unix:/k.sock", windowId: 3 } as const;

function makeHub(discoverResults: Array<HostDiscovery | null>, injected: string[] = []) {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  let i = 0;
  const hub = new InjectHub({
    emit: (sessionId, event) => events.push({ sessionId, event }),
    discover: async () => discoverResults[Math.min(i++, discoverResults.length - 1)] ?? null,
    inject: async (_host, text) => {
      injected.push(text);
    },
  });
  return { hub, events, injected };
}

const opts = { cwd: "/w", sessionFile: "/tmp/s.jsonl", agent: "claude" as const };

describe("probe / tryAttach 三态", () => {
  it("TUI+可注入宿主 → 注入接管（driver=inject、mirror=false）", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }]);
    assert.deepEqual(await t.hub.probe("s1", opts), { kind: "inject", pid: 10, host: KITTY_HOST, ambiguous: false });
    const result = await t.hub.tryAttach("s1", opts);
    assert.deepEqual(result, { attached: true, driver: "inject", mirror: false, ambiguous: false });
    assert.equal(t.hub.isAttached("s1"), true);
    assert.equal(t.events.filter((e) => e.event.type === "attach_state").length, 1);
  });

  it("TUI 无注入通道 → 409 拒绝（防与真人 TUI 双写），不登记", async () => {
    const t = makeHub([{ pid: 10, host: null, ambiguous: false }]);
    assert.deepEqual(await t.hub.probe("s1", opts), { kind: "no-host", pid: 10 });
    await assert.rejects(() => t.hub.tryAttach("s1", opts), /没有注入通道/);
    assert.equal(t.hub.isAttached("s1"), false);
  });

  it("无 TUI → probe=none（路由落后台驱动）", async () => {
    const t = makeHub([null]);
    assert.deepEqual(await t.hub.probe("s1", opts), { kind: "none" });
    await assert.rejects(() => t.hub.tryAttach("s1", opts), /未检测到/);
  });

  it("重复 attach 幂等：刷新宿主且不重复发 attach_state", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }]);
    await t.hub.tryAttach("s1", opts);
    await t.hub.tryAttach("s1", opts);
    const attached = t.events.filter((e) => e.event.type === "attach_state" && (e.event as { attached: boolean }).attached);
    assert.equal(attached.length, 1);
  });
});

describe("send：注入 / 重发现 / target-gone 降级", () => {
  it("已接管 → 注入文本（原样，不加引号处理）", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }]);
    await t.hub.tryAttach("s1", opts);
    const sent = await t.hub.send("s1", { text: "你好 \"world\"\n第二行", mode: "steer" });
    assert.ok("command" in sent);
    assert.equal(sent.command.mode, "steer");
    assert.deepEqual(t.injected, ["你好 \"world\"\n第二行"]);
  });

  it("窗口中途关闭 → { gone: true } 且登记清除（路由按「不在窗口就后台」降级）", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }, null]);
    await t.hub.tryAttach("s1", opts);
    const sent = await t.hub.send("s1", { text: "x" });
    assert.deepEqual(sent, { gone: true });
    assert.equal(t.hub.isAttached("s1"), false);
  });

  it("宿主变化自动更新（挪进 tmux 后按 tmux 注入）", async () => {
    const t = makeHub([
      { pid: 10, host: KITTY_HOST, ambiguous: false },
      { pid: 10, host: { kind: "tmux", pane: "%9" }, ambiguous: false },
    ]);
    await t.hub.tryAttach("s1", opts);
    const sent = await t.hub.send("s1", { text: "x" });
    assert.ok("command" in sent);
    assert.equal(t.hub.isAttached("s1"), true);
  });

  it("未接管发送 409；空文本 400", async () => {
    const t = makeHub([null]);
    await assert.rejects(() => t.hub.send("s1", { text: "x" }), /尚未接管/);
    const t2 = makeHub([{ pid: 1, host: KITTY_HOST, ambiguous: false }]);
    await t2.hub.tryAttach("s1", opts);
    await assert.rejects(() => t2.hub.send("s1", { text: "   " }), /不能为空/);
  });

  it("失去注入通道（TUI 还在但宿主没了）→ 409 并清登记", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }, { pid: 10, host: null, ambiguous: false }]);
    await t.hub.tryAttach("s1", opts);
    await assert.rejects(() => t.hub.send("s1", { text: "x" }), /失去注入通道/);
    assert.equal(t.hub.isAttached("s1"), false);
  });
});

describe("detach / statusFor", () => {
  it("detach 幂等 + attach_state(attached:false)", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }]);
    await t.hub.tryAttach("s1", opts);
    assert.equal(t.hub.detach("s1"), true);
    assert.equal(t.hub.detach("s1"), false);
    const states = t.events.filter((e) => e.event.type === "attach_state");
    assert.deepEqual(states.map((e) => (e.event as { attached: boolean }).attached), [true, false]);
  });

  it("statusFor：接管中 attached+driver=inject；未接管 attached:false", async () => {
    const t = makeHub([{ pid: 10, host: KITTY_HOST, ambiguous: false }]);
    assert.deepEqual(t.hub.statusFor("s1"), { online: true, attached: false, driver: "inject" });
    await t.hub.tryAttach("s1", opts);
    assert.deepEqual(t.hub.statusFor("s1"), { online: true, attached: true, driver: "inject" });
  });
});
