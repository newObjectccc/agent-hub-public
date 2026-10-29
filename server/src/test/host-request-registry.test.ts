/**
 * HostRequestRegistry 单测：attach/parallel 两路径共用的权限请求登记表。
 * - register 挂起 → 手机 respond 解结；幂等（同 requestId 复用挂起）
 * - 超时/会话收尾一律 deny（绝不自动 allow）
 * - 已决记忆（契约 §12：已决 → 409）、settled 通知、list/hasPending
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HostRequestRegistry } from "../adapters/host-request-registry.js";
import type { ServerEvent } from "../types.js";

const body = {
  sessionId: "s1",
  requestId: "call_1",
  toolName: "Bash",
  toolUseId: "call_1",
  input: { command: "rm -rf x" },
};

function makeRegistry(hostRequestTtlMs = 50) {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  const registry = new HostRequestRegistry({
    emit: (sessionId, event) => events.push({ sessionId, event }),
    hostRequestTtlMs,
  });
  return { registry, events };
}

describe("HostRequestRegistry：挂起/应答/收尾", () => {
  it("register 广播 host_request，respond 解结并广播 resolved + settled 通知", async () => {
    const { registry, events } = makeRegistry();
    const settled: string[] = [];
    registry.addSettledListener((id) => settled.push(id));
    const pending = registry.register(body);
    assert.ok(events.some((e) => e.event.type === "host_request"));
    assert.equal(registry.list("s1").length, 1);
    assert.equal(registry.hasPending("s1"), true);
    assert.equal(registry.respond("s1", "call_1", { behavior: "allow", message: "" }), true);
    assert.equal((await pending).behavior, "allow");
    assert.equal(registry.list("s1").length, 0);
    assert.equal(registry.hasPending("s1"), false);
    assert.ok(events.some((e) => e.event.type === "host_request_resolved"));
    assert.deepEqual(settled, ["s1"]);
  });

  it("幂等：同 requestId 重复 register 复用同一挂起", async () => {
    const { registry } = makeRegistry();
    const p1 = registry.register(body);
    const p2 = registry.register(body);
    registry.respond("s1", "call_1", { behavior: "deny", message: "no" });
    assert.equal((await p1).behavior, "deny");
    assert.equal((await p2).behavior, "deny");
  });

  it("超时一律 deny（绝不自动 allow）", async () => {
    const { registry } = makeRegistry();
    const pending = registry.register(body);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await pending).behavior, "deny");
  });

  it("cancelSession（run 结束/detach/崩溃）：挂起请求一律 deny 收尾", async () => {
    const { registry, events } = makeRegistry();
    const p1 = registry.register(body);
    const p2 = registry.register({ ...body, requestId: "call_2" });
    registry.cancelSession("s1", "claude 进程已退出", "cancelled");
    assert.equal((await p1).behavior, "deny");
    assert.equal((await p2).behavior, "deny");
    assert.equal(registry.hasPending("s1"), false);
    assert.equal(events.filter((e) => e.event.type === "host_request_resolved").length, 2);
  });

  it("cancelSession 幂等：无挂起时无操作", () => {
    const { registry, events } = makeRegistry();
    registry.cancelSession("nobody", "x");
    assert.equal(events.length, 0);
  });

  it("已决记忆：respond 后 isResolved 为 true，重复 respond 返回 false（路由据此 409）", () => {
    const { registry } = makeRegistry();
    void registry.register(body);
    assert.equal(registry.isResolved("call_1"), false);
    assert.equal(registry.respond("s1", "call_1", { behavior: "deny", message: "" }), true);
    assert.equal(registry.isResolved("call_1"), true);
    assert.equal(registry.respond("s1", "call_1", { behavior: "allow", message: "" }), false, "已决再应答返回 false");
  });

  it("已决记忆 TTL 过期与 sweep 清理", () => {
    const { registry } = makeRegistry();
    void registry.register(body);
    registry.respond("s1", "call_1", { behavior: "deny", message: "" });
    const later = Date.now() + 6 * 60_000;
    assert.equal(registry.isResolved("call_1", later), false, "TTL 过期后已决记忆失效");
    registry.register({ ...body, requestId: "call_3" });
    registry.respond("s1", "call_3", { behavior: "deny", message: "" });
    registry.sweep(Date.now() + 6 * 60_000);
    assert.equal(registry.isResolved("call_3", Date.now() + 6 * 60_000), false, "sweep 清理过期条目");
  });

  it("多会话隔离：cancelSession 只收尾目标会话", async () => {
    const { registry } = makeRegistry();
    const p1 = registry.register(body);
    const p2 = registry.register({ ...body, sessionId: "s2", requestId: "call_9" });
    registry.cancelSession("s1", "done");
    assert.equal((await p1).behavior, "deny");
    assert.equal(registry.hasPending("s2"), true);
    registry.respond("s2", "call_9", { behavior: "allow", message: "" });
    assert.equal((await p2).behavior, "allow");
  });
});
