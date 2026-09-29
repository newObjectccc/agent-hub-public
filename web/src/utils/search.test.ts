/**
 * 搜索工具单测：摘要高亮标记解析、chat 定位匹配、role 标签、带定位参数的 chat 路径。
 */
import { describe, expect, it } from "vitest";
import { findMessageByText, roleLabel, snippetSegments } from "./search";
import { chatPath, parseRoute, treePath } from "./router";

describe("snippetSegments 摘要高亮解析", () => {
  it("把 [[...]] 解析为高亮片段与普通片段", () => {
    expect(snippetSegments("先查 [[KPI]] 口径")).toEqual([
      { text: "先查 ", hit: false },
      { text: "KPI", hit: true },
      { text: " 口径", hit: false },
    ]);
  });

  it("多处命中全部解析；相邻命中不产生空片段", () => {
    expect(snippetSegments("[[a]][[b]]尾")).toEqual([
      { text: "a", hit: true },
      { text: "b", hit: true },
      { text: "尾", hit: false },
    ]);
  });

  it("未闭合 [[ 按普通文本处理（原文含方括号不渲染错乱）", () => {
    expect(snippetSegments("数组 [[0] 的内容")).toEqual([{ text: "数组 [[0] 的内容", hit: false }]);
    expect(snippetSegments("只有 ]] 后缀")).toEqual([{ text: "只有 ]] 后缀", hit: false }]);
  });

  it("纯命中/空串边界", () => {
    expect(snippetSegments("[[只有命中]]")).toEqual([{ text: "只有命中", hit: true }]);
    expect(snippetSegments("")).toEqual([]);
    expect(snippetSegments("[[]]空命中")).toEqual([{ text: "空命中", hit: false }]);
  });
});

describe("findMessageByText chat 定位匹配", () => {
  const messages = [
    { id: "m1", text: "帮我检查周报 KPI 口径" },
    { id: "m2", text: "好的，先看口径" },
    { id: "m3", text: "结论 98.2%" },
  ];

  it("大小写不敏感，返回首个命中 id", () => {
    expect(findMessageByText(messages, "kpi")).toBe("m1");
    expect(findMessageByText(messages, "口径")).toBe("m1");
    expect(findMessageByText(messages, "98.2%")).toBe("m3");
  });

  it("无命中/空关键词返回 null", () => {
    expect(findMessageByText(messages, "不存在")).toBeNull();
    expect(findMessageByText(messages, "   ")).toBeNull();
    expect(findMessageByText([], "kpi")).toBeNull();
  });
});

describe("roleLabel 与定位路由", () => {
  it("role 中文标签", () => {
    expect(roleLabel("user")).toBe("用户");
    expect(roleLabel("toolResult")).toBe("工具");
    expect(roleLabel("weird")).toBe("weird");
  });

  it("chatPath 带 ?q=&m= 定位参数，treePath 独立路由", () => {
    expect(chatPath("sess-1")).toBe("/s/sess-1");
    expect(chatPath("sess-1", { q: "kpi", messageId: "e2" })).toBe("/s/sess-1?q=kpi&m=e2");
    expect(parseRoute("/s/sess-1")).toEqual({ name: "chat", id: "sess-1" });
    expect(parseRoute("/s/sess-1/tree")).toEqual({ name: "tree", id: "sess-1" });
    expect(treePath("sess-1")).toBe("/s/sess-1/tree");
    expect(chatPath("a/b", { q: "x y" })).toBe("/s/a%2Fb?q=x+y");
  });
});
