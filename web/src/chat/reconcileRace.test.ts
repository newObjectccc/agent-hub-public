import { describe, it, expect } from "vitest";
import { reconcileMessages } from "./messageStream";
import type { SessionMessage } from "../api/types";
const message = (id: string, timestamp: number, role: "user" | "assistant" = "assistant"): SessionMessage => ({ id, timestamp, role, text: id, toolCalls: [] });
describe("历史请求与乱序完成消息", () => {
  it("创建时间早于插话的回复，在 GET 期间完成后仍保留", () => {
    const answer = message("answer", 100), steer = message("steer", 200, "user");
    expect(reconcileMessages([answer, steer], [steer], new Set(["answer"])).map(m => m.id)).toEqual(["answer", "steer"]);
  });
  it("进行中的下一条回复不改变前一条完成回复的存在性", () => {
    const answer = message("answer", 100), steer = message("steer", 200, "user");
    const streaming = { ...message("stream", 300), streaming: true };
    expect(reconcileMessages([answer, steer, streaming], [steer], new Set(["answer"])).map(m => m.id)).toEqual(["answer", "steer", "stream"]);
  });
  it("压缩结束后的新请求基线不复活之前已收到、现已移除的消息", () => {
    const old = message("old", 100), summary = message("summary", 200);
    expect(reconcileMessages([old], [summary], new Set()).map(m => m.id)).toEqual(["summary"]);
  });
});
