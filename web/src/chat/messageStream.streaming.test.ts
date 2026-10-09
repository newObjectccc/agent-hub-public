/**
 * 流式 streaming 标志生命周期（反馈轮 3 #4）：
 * message_start → streaming true（空内容渲染"✍️ 回复中"活占位，绝不显示"（无内容）"）；
 * message_end → settle（空消息才允许显示"（无内容）"）；对账保留 in-flight 标志。
 */
import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import { applyWsEvent, reconcileMessages } from "./messageStream";

const msg = (id: string, over: Partial<SessionMessage> = {}): SessionMessage => ({
  id,
  role: "assistant",
  timestamp: 1,
  text: "",
  toolCalls: [],
  ...over,
});

describe("streaming 标志（活占位生命周期）", () => {
  it("message_start 标记 streaming，message_end 置 false（settle）", () => {
    let msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "live-1", role: "assistant", timestamp: 1 },
    });
    expect(msgs[0].streaming).toBe(true);

    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "live-1", delta: "你好" });
    expect(msgs[0].streaming).toBe(true);

    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-1", role: "assistant", timestamp: 2, text: "你好", toolCalls: [] },
    });
    expect(msgs[0].streaming).toBe(false);
    expect(msgs[0].text).toBe("你好");
  });

  it("重复 message_start 保持 streaming（不打断进行中占位）", () => {
    let msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "live-1", role: "assistant", timestamp: 1 },
    });
    msgs = applyWsEvent(msgs, {
      type: "message_start",
      message: { id: "live-1", role: "assistant", timestamp: 2 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].streaming).toBe(true);
  });

  it("user 乐观占位回填为流式占位时标记 streaming", () => {
    // 真实场景：doSend 的 local- 乐观占位带正文（非空 text）才参与回填
    let msgs = [
      msg("local-1", { role: "user", text: "你好", timestamp: 1 }),
    ];
    msgs = applyWsEvent(msgs, {
      type: "message_start",
      message: { id: "live-user-1", role: "user", timestamp: 2 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("live-user-1");
    expect(msgs[0].streaming).toBe(true);
    expect(msgs[0].text).toBe("你好");
  });

  it("reconcileMessages 对账保留 in-flight streaming 标志，settle 消息不复活", () => {
    const prev = [msg("live-1", { streaming: true }), msg("live-2", { streaming: false }), msg("m-3")];
    const fresh = [msg("live-1"), msg("live-2"), msg("m-3", { text: "历史" })];
    const merged = reconcileMessages(prev, fresh);
    expect(merged[0].streaming).toBe(true);
    // settle 消息不复活（undefined/false 都不是进行中）
    expect(merged[1].streaming).not.toBe(true);
    expect(merged[2].streaming).not.toBe(true);
  });

  it("reconcileMessages 无 in-flight 时直接用权威列表（零拷贝路径不变）", () => {
    const prev = [msg("m-1", { streaming: false })];
    const fresh = [msg("m-1", { text: "新的" })];
    expect(reconcileMessages(prev, fresh)).toBe(fresh);
  });

  it("流式对账不丢字：GET 快照落后于已到达 delta 时保留更长的在途文本", () => {
    // 在途已累积 6 字，GET 返回的落盘旧文本只有 2 字（断线重连/刷新瞬间）
    const prev = [msg("live-1", { text: "你好，世界啊", streaming: true, thinking: "先想一大段" })];
    const fresh = [msg("live-1", { text: "你好", thinking: "想" })];
    const merged = reconcileMessages(prev, fresh);
    expect(merged[0].text).toBe("你好，世界啊");
    expect(merged[0].thinking).toBe("先想一大段");
    expect(merged[0].streaming).toBe(true);
    // message_end 权威替换后自然覆盖（此处只验证对账不回退）
    const settled = reconcileMessages(
      prev,
      [msg("live-1", { text: "你好，世界啊！完整回复", streaming: false })],
    );
    expect(settled[0].text).toBe("你好，世界啊！完整回复");
    expect(settled[0].streaming).toBe(true); // 仍在途（等 message_end）
  });

  it("在途消息尚未落盘（GET 快照里没有）时保留在尾部，进行中的回复不消失", () => {
    const prev = [msg("m-0"), msg("live-2", { text: "流式中…", streaming: true })];
    const fresh = [msg("m-0", { text: "历史" })];
    const merged = reconcileMessages(prev, fresh);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("历史");
    expect(merged[1].id).toBe("live-2");
    expect(merged[1].text).toBe("流式中…");
    expect(merged[1].streaming).toBe(true);
  });
});
