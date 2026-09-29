/**
 * live-feed 扩展纯函数测试（事件 → 契约 WS 事件映射、URL 解析）。
 * 不启动 pi 运行期、不发网络请求——扩展本体的故障静默行为由 AC3 实机验证覆盖。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_LIVE_URL,
  contentToThinking,
  createFeedState,
  mapAgentSettled,
  mapAgentStart,
  mapMessageEnd,
  mapMessageStart,
  mapMessageUpdate,
  mapToolEnd,
  mapToolStart,
  mapToolUpdate,
  resolveLiveUrl,
} from "./live-feed.js";

describe("live-feed: 事件映射（pi 事件 → 契约 WS 事件）", () => {
  it("message_start 分配流内 id，toolResult/system 消息跳过", () => {
    const state = createFeedState();
    const events = mapMessageStart(state, { role: "assistant", timestamp: 42 }, 1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "message_start");
    assert.deepEqual(events[0].message, { id: "live-1-1000", role: "assistant", timestamp: 42 });

    assert.deepEqual(mapMessageStart(state, { role: "toolResult", timestamp: 43 }, 1001), []);
    assert.deepEqual(mapMessageStart(state, { role: "system", timestamp: 44 }, 1002), []);
  });

  it("message_update：text_delta / thinking_delta 透传，thinking 累积进 state", () => {
    const state = createFeedState();
    mapMessageStart(state, { role: "assistant", timestamp: 1 }, 1000);
    const text = mapMessageUpdate(state, { type: "text_delta", delta: "你好" });
    assert.deepEqual(text, [{ type: "text_delta", messageId: "live-1-1000", delta: "你好" }]);
    const think = mapMessageUpdate(state, { type: "thinking_delta", delta: "嗯" });
    assert.deepEqual(think, [{ type: "thinking_delta", messageId: "live-1-1000", delta: "嗯" }]);
    assert.equal(state.thinkingText, "嗯");
    // 其余 assistantMessageEvent 类型（start/end/done…）与空 delta 忽略
    assert.deepEqual(mapMessageUpdate(state, { type: "text_end", content: "你好" }), []);
    assert.deepEqual(mapMessageUpdate(state, { type: "text_delta", delta: "" }), []);
  });

  it("工具三事件：start 摘要 → update 运行中快照 → end 最终结果", () => {
    const state = createFeedState();
    mapMessageStart(state, { role: "assistant", timestamp: 1 }, 1000);

    const start = mapToolStart(state, "c1", "bash", { command: "ls -la" });
    assert.deepEqual(start, [
      { type: "tool_start", messageId: "live-1-1000", toolCall: { name: "bash", summary: "ls -la" } },
    ]);

    const snapshot = mapToolUpdate(state, "c1", "bash", { content: [{ type: "text", text: "partial…" }] });
    assert.deepEqual(snapshot, [
      {
        type: "tool_end",
        messageId: "live-1-1000",
        toolCall: { name: "bash", summary: "ls -la", status: "running", resultPreview: "partial…" },
      },
    ]);

    const end = mapToolEnd(state, "c1", "bash", { content: [{ type: "text", text: "total 0" }] }, false);
    assert.deepEqual(end, [
      {
        type: "tool_end",
        messageId: "live-1-1000",
        toolCall: { name: "bash", summary: "ls -la", status: "done", resultPreview: "total 0" },
      },
    ]);

    const failed = mapToolEnd(state, "c2", "bash", { content: [] }, true);
    assert.equal(failed[0].toolCall?.status, "error");
    assert.equal(failed[0].toolCall?.resultPreview, null);
  });

  it("message_end：thinking 优先取 content 思维块，缺失时回退增量累积；toolCalls 折叠结果", () => {
    const state = createFeedState();
    mapMessageStart(state, { role: "assistant", timestamp: 7 }, 1000);
    mapMessageUpdate(state, { type: "thinking_delta", delta: "增量思维" });
    mapToolStart(state, "c1", "bash", { command: "ls" });
    mapToolEnd(state, "c1", "bash", { content: [{ type: "text", text: "ok" }] }, false);

    const events = mapMessageEnd(state, {
      role: "assistant",
      timestamp: 7,
      content: [
        { type: "thinking", thinking: "权威思维" },
        { type: "text", text: "最终回复" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    });
    assert.equal(events.length, 1);
    const message = events[0].message;
    assert.equal(message?.id, "live-1-1000");
    assert.equal(message?.text, "最终回复");
    assert.equal(message?.thinking, "权威思维");
    assert.deepEqual(message?.toolCalls, [{ name: "bash", summary: "ls", status: "done", resultPreview: "ok" }]);

    // content 无思维块时回退增量累积
    mapMessageStart(state, { role: "assistant", timestamp: 8 }, 2000);
    mapMessageUpdate(state, { type: "thinking_delta", delta: "只有增量" });
    const fallback = mapMessageEnd(state, { role: "assistant", timestamp: 8, content: [{ type: "text", text: "正文" }] });
    assert.equal(fallback[0].message?.thinking, "只有增量");
    // assistant message_end 后流内 id 复位
    assert.equal(state.currentMessageId, null);
  });

  it("工具执行发生在 assistant message_end 之后时归属 lastMessageId（pi 真实时序）", () => {
    const state = createFeedState();
    mapMessageStart(state, { role: "assistant", timestamp: 1 }, 1000);
    mapMessageEnd(state, {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }],
    });
    assert.equal(state.currentMessageId, null);
    // 工具事件仍归属刚结束的 assistant 消息（而非不存在的 live-N）
    const start = mapToolStart(state, "c1", "bash", { command: "echo hi" });
    assert.equal(start[0].messageId, "live-1-1000");
    const end = mapToolEnd(state, "c1", "bash", { content: [{ type: "text", text: "hi" }] }, false);
    assert.equal(end[0].messageId, "live-1-1000");
  });

  it("agent 生命周期：status 事件 + agent_settled", () => {
    assert.deepEqual(mapAgentStart(), [{ type: "status", status: "running" }]);
    assert.deepEqual(mapAgentSettled(), [{ type: "agent_settled" }, { type: "status", status: "idle" }]);
  });

  it("contentToThinking：多块拼接，无块为 null", () => {
    assert.equal(contentToThinking([{ type: "thinking", thinking: "a" }, { type: "text", text: "x" }, { type: "thinking", thinking: "b" }]), "a\nb");
    assert.equal(contentToThinking([{ type: "text", text: "x" }]), null);
    assert.equal(contentToThinking("plain"), null);
  });
});

describe("live-feed: 推送地址解析", () => {
  it("默认地址、AGENT_HUB_LIVE_URL 覆盖、尾斜杠归一、sessionId 编码", () => {
    assert.equal(resolveLiveUrl(undefined, "abc"), `${DEFAULT_LIVE_URL}/api/live/abc`);
    assert.equal(resolveLiveUrl("", "abc"), `${DEFAULT_LIVE_URL}/api/live/abc`);
    assert.equal(resolveLiveUrl("http://127.0.0.1:7711/", "abc"), "http://127.0.0.1:7711/api/live/abc");
    assert.equal(resolveLiveUrl("http://host:1///", "a b"), "http://host:1/api/live/a%20b");
  });
});
