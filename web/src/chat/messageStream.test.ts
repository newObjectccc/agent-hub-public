import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import { applyWsEvent } from "./messageStream";

const base = (): SessionMessage[] => [];

describe("applyWsEvent（WS 流式事件）", () => {
  it("message_start 建占位，text_delta 做打字机追加", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("");

    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "你好" });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "，世界" });
    expect(msgs[0].text).toBe("你好，世界");
  });

  it("message_end 用权威消息整体替换", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "中间态" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "最终权威文本", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("最终权威文本");
  });

  it("tool_start / tool_end 更新 toolCalls", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1 },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls -la" },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls -la", status: "done", resultPreview: "total 0" },
    });
    // toMatchObject：字段断言语义不变，容忍新增的 startedAt/endedAt 执行时长打点（e1-chat-ux）
    expect(msgs[0].toolCalls).toMatchObject([
      { name: "bash", summary: "ls -la", status: "done", resultPreview: "total 0" },
    ]);
  });

  it("未知事件与未知 messageId 不改变状态", () => {
    const msgs = base();
    expect(applyWsEvent(msgs, { type: "agent_settled" })).toBe(msgs);
    expect(applyWsEvent(msgs, { type: "text_delta", messageId: "nope", delta: "x" })).toBe(msgs);
    expect(applyWsEvent(msgs, { type: "thinking_delta", messageId: "nope", delta: "x" })).toBe(msgs);
  });
});

describe("thinking_delta 思维链累积", () => {
  it("thinking_delta 累积到消息 thinking 字段，与 text_delta 互不干扰", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "先想" });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "m1", delta: "回答" });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "一下" });
    expect(msgs[0].thinking).toBe("先想一下");
    expect(msgs[0].text).toBe("回答");
  });

  it("message_end 带 thinking 时一并显示（整体替换）", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "流式思维" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", thinking: "权威思维链", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thinking).toBe("权威思维链");
    expect(msgs[0].text).toBe("正文");
  });

  it("message_end 未带 thinking 时保留流式累积的思维链（不被抹掉）", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1000 },
    });
    msgs = applyWsEvent(msgs, { type: "thinking_delta", messageId: "m1", delta: "流式思维" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", toolCalls: [] },
    });
    expect(msgs[0].thinking).toBe("流式思维");
  });

  it("无思维链消息 thinking 为 null（MessageBubble 不渲染折叠块）", () => {
    const msgs = applyWsEvent(base(), {
      type: "message_end",
      message: { id: "m1", role: "assistant", timestamp: 1000, text: "正文", thinking: null, toolCalls: [] },
    });
    expect(msgs[0].thinking).toBeNull();
  });
});

describe("tool_start 合并 pending 工具卡（pi 真实时序：工具执行在 message_end 之后）", () => {
  it("message_end 已带 pending 工具卡时，tool_start/tool_end 更新同一张卡，不重复追加", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_end",
      message: {
        id: "live-2",
        role: "assistant",
        timestamp: 1,
        text: "我要执行命令",
        thinking: null,
        toolCalls: [{ name: "bash", summary: "echo hi", status: "pending", resultPreview: null }],
      },
    });
    msgs = applyWsEvent(msgs, { type: "tool_start", messageId: "live-2", toolCall: { name: "bash", summary: "echo hi" } });
    expect(msgs[0].toolCalls).toHaveLength(1);
    expect(msgs[0].toolCalls[0].status).toBe("running");
    msgs = applyWsEvent(msgs, {
      type: "tool_end",
      messageId: "live-2",
      toolCall: { name: "bash", summary: "echo hi", status: "done", resultPreview: "hi" },
    });
    expect(msgs[0].toolCalls).toHaveLength(1);
    // toMatchObject：字段断言语义不变，容忍新增的 startedAt/endedAt 执行时长打点（e1-chat-ux）
    expect(msgs[0].toolCalls[0]).toMatchObject({ name: "bash", summary: "echo hi", status: "done", resultPreview: "hi" });
  });

  it("没有同名 pending 卡时 tool_start 照旧追加新卡", () => {
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", timestamp: 1 },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "bash", summary: "ls" },
    });
    msgs = applyWsEvent(msgs, {
      type: "tool_start",
      messageId: "m1",
      toolCall: { name: "read", summary: "a.txt" },
    });
    expect(msgs[0].toolCalls).toHaveLength(2);
    expect(msgs[0].toolCalls.map((t) => t.name)).toEqual(["bash", "read"]);
  });
});

describe("message_end 内容级去重兜底（重复气泡防御）", () => {
  it("不同 id 但同 role+同 text 且时间接近时合并为一条，保留权威 id", () => {
    // 流式占位（旧 bug：占位 id 与权威 id 不一致）
    let msgs = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "stream-1", role: "assistant", timestamp: 1_000 },
    });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "stream-1", delta: "最终回复内容" });
    // 权威投递 id 不同但内容一致（时间接近）
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-9", role: "assistant", timestamp: 2_000, text: "最终回复内容", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("authoritative-9");
    expect(msgs[0].text).toBe("最终回复内容");
  });

  it("同 role+同 text 但时间相隔久远且不相邻时不去重（保留合法重复）", () => {
    const msgs: SessionMessage[] = [
      { id: "a", role: "user", timestamp: 0, text: "同样的内容", toolCalls: [] },
      { id: "b", role: "assistant", timestamp: 10, text: "占位", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "c", role: "user", timestamp: 3_600_000, text: "同样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(3);
    expect(next.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("相邻但 text 为空的多条消息不去重（工具卡占位安全）", () => {
    const msgs: SessionMessage[] = [
      { id: "a", role: "assistant", timestamp: 0, text: "", toolCalls: [{ name: "bash", summary: "x", status: "done", resultPreview: null }] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "b", role: "assistant", timestamp: 1, text: "", toolCalls: [{ name: "read", summary: "y", status: "done", resultPreview: null }] },
    });
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("纯空气泡终态不新增（text 空、无工具卡/思维链/图片/错误）", () => {
    const msgs: SessionMessage[] = [
      { id: "a", role: "user", timestamp: 0, text: "你好", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "b", role: "assistant", timestamp: 1, text: "", toolCalls: [] },
    });
    expect(next).toHaveLength(1);
    expect(next.map((m) => m.id)).toEqual(["a"]);
  });

  it("流式占位收束为空 assistant 终态时连占位一起移除", () => {
    const msgs: SessionMessage[] = [
      { id: "user-1", role: "user", timestamp: 0, text: "你好", toolCalls: [] },
      { id: "live-1", role: "assistant", timestamp: 1, text: "", toolCalls: [], streaming: true },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-1", role: "assistant", timestamp: 2, text: "", toolCalls: [] },
    });
    expect(next.map((m) => m.id)).toEqual(["user-1"]);
  });

  it("空文本但带思维链/错误的终态不按空气泡丢弃", () => {
    const msgs: SessionMessage[] = [];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "a", role: "assistant", timestamp: 1, text: "", toolCalls: [], thinking: "内部推理", error: { message: "模型/网络失败", kind: "other" } },
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("a");
    expect(next[0].error).toEqual({ message: "模型/网络失败", kind: "other" });
  });

  it("同 role+同 text、时间接近、但中间隔有其它消息 → 不合并（占位形态 id）", () => {
    const msgs: SessionMessage[] = [
      { id: "live-1", role: "user", timestamp: 0, text: "同样的内容", toolCalls: [] },
      { id: "b", role: "assistant", timestamp: 5, text: "中间的回复", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-2", role: "user", timestamp: 10, text: "同样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(3);
    expect(next.map((m) => m.id)).toEqual(["live-1", "b", "authoritative-2"]);
  });

  it("相邻且占位形态 id 但 text 不同 → 不合并", () => {
    const msgs: SessionMessage[] = [
      { id: "live-9", role: "assistant", timestamp: 0, text: "第一版回复", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-3", role: "assistant", timestamp: 1, text: "不一样的内容", toolCalls: [] },
    });
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id)).toEqual(["live-9", "authoritative-3"]);
  });

  it("user 乐观占位（local-）被权威消息回填，保留权威 id 且只留 1 条", () => {
    const msgs: SessionMessage[] = [
      { id: "local-17", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "authoritative-user", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("authoritative-user");
    expect(next[0].text).toBe("hi");
  });
});

describe("message_end 连续同文本占位（快速连发）FIFO 回填", () => {
  it("连续两条同文本占位：权威消息按到达顺序各自回填，2 条独立显示不重复", () => {
    // 快速连发两条相同文本：两条乐观占位并存
    let msgs: SessionMessage[] = [
      { id: "local-a", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
      { id: "local-b", role: "user", timestamp: 1, text: "hi", toolCalls: [] },
    ];
    // 第一条权威回显（对应 local-a）：合并尾部连续段最早一条，不许错位吃掉 local-b
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "user-1", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    expect(msgs.map((m) => m.id)).toEqual(["user-1", "local-b"]);
    // 第二条权威回显：回填 local-b
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "user-2", role: "user", timestamp: 3, text: "hi", toolCalls: [] },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.id)).toEqual(["user-1", "user-2"]);
  });

  it("第二条权威先到（乱序）也不残留：尾部段内仍按序回填", () => {
    let msgs: SessionMessage[] = [
      { id: "local-a", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
      { id: "local-b", role: "user", timestamp: 1, text: "hi", toolCalls: [] },
    ];
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "user-2", role: "user", timestamp: 3, text: "hi", toolCalls: [] },
    });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "user-1", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    // 条数正确（2 条）：连续同文本场景不因占位合并失败而重复显示
    expect(msgs).toHaveLength(2);
  });

  it("连续两条相同文本的合法权威消息（非占位 id）各自独立显示，不误合并", () => {
    const msgs: SessionMessage[] = [
      { id: "user-1", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
      { id: "user-2", role: "user", timestamp: 1, text: "hi", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "user-3", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    expect(next).toHaveLength(3);
    expect(next.map((m) => m.id)).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("assistant 流式占位 id 与权威 id 不一致（tail/live 双推送）：同文本合并为 1 条", () => {
    let msgs: SessionMessage[] = [
      { id: "live-7", role: "assistant", timestamp: 0, text: "干完了", toolCalls: [] },
    ];
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "entry-abc", role: "assistant", timestamp: 5, text: "干完了", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("entry-abc");
  });
});

describe("message_start（user）乐观占位回填（pi SDK 双占位重复 bug）", () => {
  it("user message_start 回填乐观占位（不追加第二条），message_end 同 id 覆盖后仍 1 条", () => {
    // 手机实测复现路径：doSend 乐观占位 + WS user message_start 流式占位 + message_end
    let msgs: SessionMessage[] = [
      { id: "local-x", role: "user", timestamp: 0, text: "最后一轮诊断消息", toolCalls: [] },
    ];
    msgs = applyWsEvent(msgs, {
      type: "message_start",
      message: { id: "live-5-1", role: "user", timestamp: 1 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("live-5-1");
    expect(msgs[0].text).toBe("最后一轮诊断消息");

    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-5-1", role: "user", timestamp: 1, text: "最后一轮诊断消息", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("live-5-1");
  });

  it("连续两条同文本 user：start/end 各自收敛，2 条独立不重复", () => {
    let msgs: SessionMessage[] = [
      { id: "local-1", role: "user", timestamp: 0, text: "hi", toolCalls: [] },
      { id: "local-2", role: "user", timestamp: 1, text: "hi", toolCalls: [] },
    ];
    msgs = applyWsEvent(msgs, { type: "message_start", message: { id: "live-a", role: "user", timestamp: 2 } });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-a", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
    });
    msgs = applyWsEvent(msgs, { type: "message_start", message: { id: "live-b", role: "user", timestamp: 3 } });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-b", role: "user", timestamp: 3, text: "hi", toolCalls: [] },
    });
    // 核心：2 条独立显示（不重复、不误合并）；id 可能保留本地占位形态（无视觉影响）
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.text === "hi")).toBe(true);
  });

  it("快速连发两条不同文本：start/end 收敛后条数与内容顺序均正确", () => {
    let msgs: SessionMessage[] = [
      { id: "local-1", role: "user", timestamp: 0, text: "第一条", toolCalls: [] },
      { id: "local-2", role: "user", timestamp: 1, text: "第二条", toolCalls: [] },
    ];
    msgs = applyWsEvent(msgs, { type: "message_start", message: { id: "live-a", role: "user", timestamp: 2 } });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-a", role: "user", timestamp: 2, text: "第一条", toolCalls: [] },
    });
    msgs = applyWsEvent(msgs, { type: "message_start", message: { id: "live-b", role: "user", timestamp: 3 } });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-b", role: "user", timestamp: 3, text: "第二条", toolCalls: [] },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.text)).toEqual(["第一条", "第二条"]);
  });

  it("assistant message_start 不吞并已有 assistant 消息（新流式独立追加）", () => {
    const msgs: SessionMessage[] = [
      { id: "live-1", role: "assistant", timestamp: 0, text: "上一轮回复", toolCalls: [] },
    ];
    const next = applyWsEvent(msgs, {
      type: "message_start",
      message: { id: "live-2", role: "assistant", timestamp: 5 },
    });
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id)).toEqual(["live-1", "live-2"]);
  });

  it("user message_start 无乐观占位时照旧追加（外部/tail 回显场景）", () => {
    const next = applyWsEvent(base(), {
      type: "message_start",
      message: { id: "live-9", role: "user", timestamp: 1 },
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("live-9");
    expect(next[0].text).toBe("");
  });
});
