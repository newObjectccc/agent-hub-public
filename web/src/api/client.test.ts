/**
 * sendPrompt 幂等键回归（P1 弱网重发无幂等键 → 同文双发双执行）：
 * 请求体带 clientMessageId（= 乐观占位 localId）；请求超时自动重试时同键重发，
 * server 端按 clientMessageId 去重，保证同一条消息只执行一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ accepted: true, mode: "prompt" }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.sendPrompt clientMessageId 幂等键", () => {
  it("请求体带 clientMessageId 与 images（契约 §1）", async () => {
    await api.sendPrompt("s1", "看图", "prompt", ["p/a.png"], "local-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/prompt");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "看图",
      mode: "prompt",
      images: ["p/a.png"],
      clientMessageId: "local-1",
    });
  });

  it("无 images / 无键时不带对应字段（旧请求形状不变）", async () => {
    await api.sendPrompt("s1", "hi", "followUp");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      text: "hi",
      mode: "followUp",
    });
  });

  it("重发同键：超时重试两次请求 clientMessageId 相同（server 去重防双发）", async () => {
    await api.sendPrompt("s1", "hi", "prompt", undefined, "local-42");
    await api.sendPrompt("s1", "hi", "prompt", undefined, "local-42");
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies[0].clientMessageId).toBe("local-42");
    expect(bodies[1].clientMessageId).toBe("local-42");
  });
});
