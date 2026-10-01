/**
 * 输入框文本插入纯函数单测：insertSnippet（追加）/ insertAtCursor / insertSnippetAtCursor（光标处模板插入）。
 */
import { describe, expect, it } from "vitest";
import { insertAtCursor, insertSnippet, insertSnippetAtCursor } from "./insert";

describe("insertSnippet：追加到现有文本", () => {
  it("空文本直接放片段；非空时换行衔接", () => {
    expect(insertSnippet("", "解释这段代码")).toBe("解释这段代码");
    expect(insertSnippet("前文", "解释这段代码")).toBe("前文\n解释这段代码");
  });

  it("片段两侧空白 trim；纯空白片段原样返回", () => {
    expect(insertSnippet("前文  ", "  片段  ")).toBe("前文\n片段");
    expect(insertSnippet("前文", "   ")).toBe("前文");
    expect(insertSnippet("", "")).toBe("");
  });
});

describe("insertAtCursor：基础光标插入", () => {
  it("插到光标处，不吞光标后内容，返回新光标", () => {
    expect(insertAtCursor("ab", 1, "X")).toEqual({ text: "aXb", cursor: 2 });
  });

  it("光标越界 clamp 到 [0, len]", () => {
    expect(insertAtCursor("ab", -5, "X")).toEqual({ text: "Xab", cursor: 1 });
    expect(insertAtCursor("ab", 99, "X")).toEqual({ text: "abX", cursor: 3 });
  });
});

describe("insertSnippetAtCursor：模板插入光标处（快捷指令）", () => {
  it("空文本：片段即全文，光标落在末尾", () => {
    expect(insertSnippetAtCursor("", 0, "解释这段代码")).toEqual({ text: "解释这段代码", cursor: 6 });
  });

  it("光标在末尾且已有内容：换行衔接（与 insertSnippet 追加语义一致）", () => {
    const r = insertSnippetAtCursor("前文", 2, "解释这段代码");
    expect(r.text).toBe("前文\n解释这段代码");
    expect(r.cursor).toBe(r.text.length);
  });

  it("光标在中间：保留光标后内容，前后黏连时补换行", () => {
    const r = insertSnippetAtCursor("foobar", 3, "模板");
    expect(r.text).toBe("foo\n模板\nbar");
    // 光标停在插入片段之后（含后置换行之前的位置由实现统一为片段结尾后）
    expect(r.text.slice(r.cursor)).toBe("bar");
  });

  it("光标前后已是空白/换行时不重复补换行", () => {
    expect(insertSnippetAtCursor("前文\n", 3, "模板").text).toBe("前文\n模板");
    expect(insertSnippetAtCursor("  后文", 0, "模板").text).toBe("模板  后文");
  });

  it("纯空白/空片段原样返回；光标越界 clamp（仍换行衔接）", () => {
    expect(insertSnippetAtCursor("abc", 1, "   ")).toEqual({ text: "abc", cursor: 1 });
    expect(insertSnippetAtCursor("abc", 99, "X")).toEqual({ text: "abc\nX", cursor: 5 });
    expect(insertSnippetAtCursor("abc", -1, "X")).toEqual({ text: "X\nabc", cursor: 2 });
  });

  it("纯函数：不修改入参字符串语义（原值不变）", () => {
    const text = "原内容";
    insertSnippetAtCursor(text, 3, "X");
    expect(text).toBe("原内容");
  });
});
