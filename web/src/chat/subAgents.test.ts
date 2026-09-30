/**
 * 子代理活动合并（反馈轮 3 #4）：WS 增量合并、并行/完成语义、运行时长标签。
 */
import { describe, expect, it } from "vitest";
import type { SubAgentActivity } from "../api/types";
import { elapsedLabel, isSubAgentActivityUpdate, mergeSubAgentActivity } from "./subAgents";

function agent(over: Partial<SubAgentActivity> = {}): SubAgentActivity {
  return {
    sessionId: "sub-1",
    name: "developer#abc123",
    status: "running",
    currentTool: "bash grep",
    toolRunning: true,
    lastOutput: null,
    startedAt: 1000,
    updatedAt: 2000,
    done: false,
    resultSummary: null,
    ...over,
  };
}

describe("isSubAgentActivityUpdate", () => {
  it("只认带非空 sessionId 的对象", () => {
    expect(isSubAgentActivityUpdate({ sessionId: "sub-1", done: true })).toBe(true);
    expect(isSubAgentActivityUpdate({ sessionId: "" })).toBe(false);
    expect(isSubAgentActivityUpdate(null)).toBe(false);
    expect(isSubAgentActivityUpdate({ noSession: 1 })).toBe(false);
    expect(isSubAgentActivityUpdate("sub-1")).toBe(false);
  });
});

describe("mergeSubAgentActivity", () => {
  it("新子代理插入列表尾部，缺省字段兜底", () => {
    const next = mergeSubAgentActivity([], { sessionId: "sub-1", name: "developer#abc123" });
    expect(next).toHaveLength(1);
    expect(next[0].sessionId).toBe("sub-1");
    expect(next[0].name).toBe("developer#abc123");
    expect(next[0].done).toBe(false);
    expect(next[0].status).toBe("running");
  });

  it("同 id 增量合并（工具/输出滚动更新），不动其他行", () => {
    const list = [agent({ sessionId: "sub-1" }), agent({ sessionId: "sub-2", name: "tester#def" })];
    const next = mergeSubAgentActivity(list, {
      sessionId: "sub-2",
      currentTool: "Read foo.ts",
      toolRunning: false,
      lastOutput: "正在分析根因…",
      updatedAt: 3000,
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(list[0]);
    expect(next[1].currentTool).toBe("Read foo.ts");
    expect(next[1].toolRunning).toBe(false);
    expect(next[1].lastOutput).toBe("正在分析根因…");
    expect(next[1].name).toBe("tester#def");
  });

  it("done 增量把卡片收尾，并把最后输出回填为结果摘要", () => {
    const list = [agent({ lastOutput: "全部完成，测试通过" })];
    const next = mergeSubAgentActivity(list, { sessionId: "sub-1", status: "idle", done: true, updatedAt: 4000 });
    expect(next[0].done).toBe(true);
    expect(next[0].status).toBe("idle");
    expect(next[0].resultSummary).toBe("全部完成，测试通过");
  });

  it("undefined 字段不清空已有值（增量只带变化字段）", () => {
    const list = [agent()];
    const next = mergeSubAgentActivity(list, { sessionId: "sub-1", lastOutput: "新输出" });
    expect(next[0].currentTool).toBe("bash grep");
    expect(next[0].lastOutput).toBe("新输出");
  });
});

describe("elapsedLabel", () => {
  it("mm:ss / h:mm:ss 格式，负值兜底 0:00", () => {
    expect(elapsedLabel(0, 0)).toBe("0:00");
    expect(elapsedLabel(0, 65_000)).toBe("1:05");
    expect(elapsedLabel(0, 3_725_000)).toBe("1:02:05");
    expect(elapsedLabel(null, 5000)).toBe("0:00");
    expect(elapsedLabel(10_000, 5_000)).toBe("0:00");
  });
});
