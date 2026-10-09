/**
 * WS 实时路径图片保留回归（P0：手机发图 → server 落盘后 WS message_end 权威回填 → 气泡图片消失）：
 * 1. normalize 保留 images（message_start / message_end 带图不丢）
 * 2. 权威替换 images 缺省时回退 previous.images（占位预览/流式回填不被抹掉）
 * 3. 权威消息显式带 images 时以权威为准（含显式空数组）
 * 4. 流式中带图替换：text_delta 累积 + message_end 无图 → 图片保留、文本权威
 * 5. 尾部占位合并（user local-* 乐观占位回填）同样不丢图
 * 6. 未知事件 type dev 环境 warn（防新增事件静默丢）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageImage, SessionMessage } from "../api/types";
import { applyWsEvent } from "./messageStream";

const img = (url: string): MessageImage[] => [{ url, alt: null }];

describe("messageStream images 保留/回退", () => {
  it("message_start 带 images 时占位消息保留图片", () => {
    const msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "live-1", role: "user", timestamp: 1, images: img("data:image/png;base64,AAA") },
    });
    expect(msgs[0].images).toEqual(img("data:image/png;base64,AAA"));
  });

  it("message_end 权威不带 images（缺省）→ 回退 previous.images，图片不消失", () => {
    let msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "m1", role: "user", timestamp: 1, images: img("https://x/1.png") },
    });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "user", timestamp: 2, text: "看图", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("看图");
    expect(msgs[0].images).toEqual(img("https://x/1.png"));
  });

  it("message_end 显式带 images 时以权威为准（含显式空数组）", () => {
    let msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "m1", role: "user", timestamp: 1, images: img("https://x/1.png") },
    });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: {
        id: "m1",
        role: "user",
        timestamp: 2,
        text: "看图",
        toolCalls: [],
        images: img("https://x/2.png"),
      },
    });
    expect(msgs[0].images).toEqual(img("https://x/2.png"));

    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "m1", role: "user", timestamp: 3, text: "看图", toolCalls: [], images: [] },
    });
    expect(msgs[0].images).toEqual([]);
  });

  it("流式中带图替换：text_delta 累积后 message_end 无图 → 图片保留且文本为权威全文", () => {
    let msgs = applyWsEvent([], {
      type: "message_start",
      message: { id: "live-1", role: "user", timestamp: 1, images: img("data:image/jpeg;base64,BBB") },
    });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "live-1", delta: "帮我看看" });
    msgs = applyWsEvent(msgs, { type: "text_delta", messageId: "live-1", delta: "这张图" });
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-1", role: "user", timestamp: 2, text: "帮我看看这张图", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("帮我看看这张图");
    expect(msgs[0].images).toEqual(img("data:image/jpeg;base64,BBB"));
  });

  it("user 乐观占位（local-*）尾部回填合并同样不丢图", () => {
    let msgs: SessionMessage[] = [
      {
        id: "local-1",
        role: "user",
        timestamp: 1,
        text: "看看这个",
        toolCalls: [],
        images: img("data:image/png;base64,CCC"),
      },
    ];
    msgs = applyWsEvent(msgs, {
      type: "message_end",
      message: { id: "live-user-9", role: "user", timestamp: 2, text: "看看这个", toolCalls: [] },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("live-user-9");
    expect(msgs[0].images).toEqual(img("data:image/png;base64,CCC"));
  });
});

describe("未知事件 dev 告警（防新增事件静默丢）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("完全未知的事件 type 在 dev 环境 console.warn（已知非消息流事件不告警）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const msgs: SessionMessage[] = [];
    // 已知非消息流事件（UI 层另行处理）不告警
    expect(applyWsEvent(msgs, { type: "agent_settled" })).toBe(msgs);
    expect(applyWsEvent(msgs, { type: "status", status: "running" })).toBe(msgs);
    expect(warn).not.toHaveBeenCalled();
    // 未知事件告警但状态不变
    expect(applyWsEvent(msgs, { type: "brand_new_event" })).toBe(msgs);
    if (import.meta.env.DEV) {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("brand_new_event");
    }
  });
});
