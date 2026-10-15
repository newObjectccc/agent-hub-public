/**
 * 对话导航条纯逻辑回归（K1）：
 * 1. 刻度模型：标题取首句、摘要截断、空文本占位（工具/图片/流式）、markdown 剥离
 * 2. 刻度长度映射：weight 0..1 → [5, 15]px，越界 clamp
 * 3. 视口指示器几何：比例映射 + 边界防御（scrollHeight 0 / 内容不足一屏）
 * 4. 跳转 scrollTop 估算：行高缺失按均值补齐、结果 clamp 到合法滚动范围
 */
import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../api/types";
import {
  buildNavTicks,
  estimateJumpTop,
  NAV_MIN_MESSAGES,
  plainText,
  tickLength,
  TICK_MAX_LEN,
  TICK_MIN_LEN,
  viewportRatio,
} from "./navTicks";

function msg(id: string, text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id, role: "assistant", timestamp: 1700000000000, text, toolCalls: [], ...extra };
}

describe("plainText markdown 剥离", () => {
  it("代码块/图片/链接/强调转纯文本占位", () => {
    expect(plainText("看这段：\n```js\nconst a = 1;\n```\n结束")).toContain("[代码块]");
    expect(plainText("![图](x.png)")).toBe("[图片]");
    expect(plainText("[文档](https://x.dev)")).toBe("文档");
    expect(plainText("## 标题 **加粗** 和 `行内码`")).toBe("标题 加粗 和 行内码");
  });
});

describe("buildNavTicks 刻度模型", () => {
  it("标题取首句、摘要为剩余文本", () => {
    const ticks = buildNavTicks([msg("a", "为什么不实现呢？看板视图切换，还有通用日期都能实现。之后继续落实。")]);
    expect(ticks[0].title).toBe("为什么不实现呢？");
    expect(ticks[0].preview).toContain("看板视图切换");
  });

  it("超长标题/摘要截断加省略号", () => {
    const ticks = buildNavTicks([msg("a", "a".repeat(200))]);
    expect(ticks[0].title.length).toBeLessThanOrEqual(29);
    expect(ticks[0].title.endsWith("…")).toBe(true);
    expect(ticks[0].preview.endsWith("…")).toBe(true);
  });

  it("空文本占位：工具调用/图片/流式/无内容", () => {
    const ticks = buildNavTicks([
      msg("a", "", { toolCalls: [{ name: "bash", summary: "npm test", status: "done", resultPreview: null }] }),
      msg("b", "", { images: [{ url: "x.png", alt: null }] }),
      msg("c", "", { streaming: true }),
      msg("d", ""),
    ]);
    expect(ticks[0].title).toBe("🔧 npm test");
    expect(ticks[1].title).toBe("[图片]");
    expect(ticks[2].title).toBe("回复中…");
    expect(ticks[3].title).toBe("（无内容）");
  });

  it("weight 落在 0..1 且随内容量递增；index 与入参同序", () => {
    const ticks = buildNavTicks([msg("a", "短"), msg("b", "长".repeat(1000))]);
    expect(ticks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(ticks.map((t) => t.index)).toEqual([0, 1]);
    expect(ticks[0].weight).toBeGreaterThanOrEqual(0.12);
    expect(ticks[1].weight).toBeLessThanOrEqual(1);
    expect(ticks[1].weight).toBeGreaterThan(ticks[0].weight);
  });

  it("角色/时间戳透传（刻度分色与预览元信息用）", () => {
    const ticks = buildNavTicks([msg("a", "你好", { role: "user", timestamp: 42 })]);
    expect(ticks[0].role).toBe("user");
    expect(ticks[0].timestamp).toBe(42);
    expect(NAV_MIN_MESSAGES).toBeGreaterThanOrEqual(2);
  });
});

describe("tickLength 刻度长度映射", () => {
  it("weight 0..1 映射到 [min, max]，越界 clamp", () => {
    expect(tickLength(0)).toBe(TICK_MIN_LEN);
    expect(tickLength(1)).toBe(TICK_MAX_LEN);
    expect(tickLength(-5)).toBe(TICK_MIN_LEN);
    expect(tickLength(5)).toBe(TICK_MAX_LEN);
    expect(tickLength(0.5)).toBeCloseTo((TICK_MIN_LEN + TICK_MAX_LEN) / 2);
  });
});

describe("viewportRatio 视口指示器几何", () => {
  it("scrollHeight/clientHeight 不可测 → 整条兜底", () => {
    expect(viewportRatio({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toEqual({ top: 0, height: 1 });
  });

  it("内容不足一屏 → 顶部起整高比例", () => {
    const r = viewportRatio({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 });
    expect(r.top).toBe(0);
    expect(r.height).toBe(1);
  });

  it("长内容 → top 按 scrollTop 比例、height 按视口比例", () => {
    const r = viewportRatio({ scrollTop: 500, scrollHeight: 2000, clientHeight: 500 });
    expect(r.top).toBeCloseTo(0.25);
    expect(r.height).toBeCloseTo(0.25);
  });

  it("滚到底不越界（top + height ≤ 1）", () => {
    const r = viewportRatio({ scrollTop: 1900, scrollHeight: 2000, clientHeight: 500 });
    expect(r.top + r.height).toBeLessThanOrEqual(1);
  });
});

describe("estimateJumpTop 跳转滚动偏移估算", () => {
  it("全测行高：目标滚到视口中线", () => {
    // 目标 index=2：top = 0 + (100+10)*2 = 220；中线对齐 → 220 - (600-100)/2 = -30 → clamp 0
    expect(
      estimateJumpTop({
        heights: [100, 100, 100, 100],
        gap: 10,
        targetIndex: 2,
        listOffset: 0,
        viewportHeight: 600,
        contentHeight: 2000,
      }),
    ).toBe(0);
    // 目标 index=20 不存在 → 用 index=3：top = 330；330 - 250 = 80
    expect(
      estimateJumpTop({
        heights: [100, 100, 100, 100],
        gap: 10,
        targetIndex: 3,
        listOffset: 0,
        viewportHeight: 600,
        contentHeight: 2000,
      }),
    ).toBe(80);
  });

  it("未测行高按已测均值补齐", () => {
    // 均值 100（[100, 0, 100]）；目标 index=2：top = (100+10) + (100+10) = 220
    const top = estimateJumpTop({
      heights: [100, 0, 100],
      gap: 10,
      targetIndex: 2,
      listOffset: 0,
      viewportHeight: 400,
      contentHeight: 2000,
    });
    expect(top).toBe(220 - (400 - 100) / 2);
  });

  it("listOffset 计入（加载更早按钮等占位）", () => {
    const top = estimateJumpTop({
      heights: [100],
      gap: 10,
      targetIndex: 0,
      listOffset: 250,
      viewportHeight: 400,
      contentHeight: 2000,
    });
    expect(top).toBe(250 - (400 - 100) / 2);
  });

  it("结果 clamp 到 [0, contentHeight - viewportHeight]", () => {
    // 估算值 220 超出 maxScroll 200 → 夹紧到 200
    const top = estimateJumpTop({
      heights: [100, 100, 100],
      gap: 10,
      targetIndex: 2,
      listOffset: 0,
      viewportHeight: 100,
      contentHeight: 300,
    });
    expect(top).toBe(200);
  });
});
