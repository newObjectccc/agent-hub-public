import { describe, expect, it } from "vitest";
import { QUOTE_MAX_LINES, QUOTE_SUMMARY_LIMIT, quoteSummary, toMarkdownQuote, withQuote } from "./quote";

describe("quote: quoteSummary", () => {
  it("压成单行并截断", () => {
    expect(quoteSummary("你好\n世界")).toBe("你好 世界");
    expect(quoteSummary("  空白  归一  ")).toBe("空白 归一");
    const out = quoteSummary("x".repeat(QUOTE_SUMMARY_LIMIT + 10));
    expect(out.length).toBe(QUOTE_SUMMARY_LIMIT + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("quote: toMarkdownQuote", () => {
  it("每行加 `> `，空行 `>`", () => {
    expect(toMarkdownQuote("第一行\n\n第二行")).toBe("> 第一行\n>\n> 第二行");
  });

  it("超行数截断并追加 `> …`", () => {
    const text = Array.from({ length: QUOTE_MAX_LINES + 3 }, (_, i) => `l${i}`).join("\n");
    const lines = toMarkdownQuote(text).split("\n");
    expect(lines.length).toBe(QUOTE_MAX_LINES + 1);
    expect(lines.at(-1)).toBe("> …");
  });
});

describe("quote: withQuote", () => {
  it("引用块 + 空行 + 正文", () => {
    expect(withQuote("原文", "回复内容")).toBe("> 原文\n\n回复内容");
  });

  it("正文为空时只发引用块", () => {
    expect(withQuote("原文", "   ")).toBe("> 原文");
  });
});
