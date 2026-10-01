/**
 * GET /api/usage 客户端映射（契约 §14）单测：
 * URL 构造（?days= / ?sessionId=）、响应透传、错误信封 → ApiError。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./client";
import type { UsageOverview, UsageSessionDetail } from "./types";

const overviewFixture: UsageOverview = {
  windows: {
    today: { totalTokens: 162, input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, costTotal: 3 },
    last7Days: { totalTokens: 177, input: 110, output: 24, cacheRead: 30, cacheWrite: 5, reasoning: 8, costTotal: 3 },
    all: { totalTokens: 192, input: 120, output: 28, cacheRead: 30, cacheWrite: 5, reasoning: 9, costTotal: 3 },
  },
  sessions: [
    { sessionId: "s-1", name: "pi-demo", updatedAt: "2026-02-18T11:58:00.000Z", usage: overviewUsage() },
  ],
};

function overviewUsage() {
  return { totalTokens: 162, input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, costTotal: 3 };
}

function stubFetch(impl: (url: string) => { ok: boolean; status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const res = impl(String(url));
    return { ok: res.ok, status: res.status, json: async () => res.body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.getUsage：全局汇总", () => {
  it("无参调用 GET /api/usage，响应透传", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, status: 200, body: overviewFixture }));
    const out = await api.getUsage();
    expect(fetchMock).toHaveBeenCalledWith("/api/usage", expect.anything());
    expect(out.windows.today.totalTokens).toBe(162);
    expect(out.sessions[0].sessionId).toBe("s-1");
  });

  it("?days=N 自定义时间窗拼进查询串", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, status: 200, body: overviewFixture }));
    await api.getUsage({ days: 7 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/usage?days=7");
  });
});

describe("api.getSessionUsage：单会话汇总", () => {
  const detailFixture: UsageSessionDetail = {
    sessionId: "s-1",
    name: "pi-demo",
    updatedAt: "2026-02-18T11:58:00.000Z",
    windows: overviewFixture.windows,
    range: { days: 7, usage: overviewUsage() },
  };

  it("sessionId + days 拼进查询串，响应透传", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, status: 200, body: detailFixture }));
    const out = await api.getSessionUsage("s-1", { days: 7 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/usage?sessionId=s-1&days=7");
    expect(out.range?.days).toBe(7);
  });

  it("sessionId 缺省 days 只带 sessionId", async () => {
    const fetchMock = stubFetch(() => ({ ok: true, status: 200, body: detailFixture }));
    await api.getSessionUsage("s-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/usage?sessionId=s-1");
  });
});

describe("api.getUsage：错误信封 → ApiError", () => {
  it("404 SESSION_NOT_FOUND 归一为 ApiError（code/status 保留）", async () => {
    stubFetch(() => ({ ok: false, status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "会话不存在: x" } } }));
    await expect(api.getSessionUsage("x")).rejects.toMatchObject({
      name: "ApiError",
      code: "SESSION_NOT_FOUND",
      status: 404,
      message: "会话不存在: x",
    } satisfies Partial<ApiError>);
  });

  it("400 INVALID_REQUEST 同样归一（days 非法）", async () => {
    stubFetch(() => ({ ok: false, status: 400, body: { error: { code: "INVALID_REQUEST", message: "days 必须是 1..3650 的整数" } } }));
    await expect(api.getUsage({ days: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
  });
});
