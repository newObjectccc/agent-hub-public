/**
 * 文件路径识别正则单测（工具调用卡片文件联动的数据层）。
 */
import { describe, expect, it } from "vitest";
import { FILE_REF_RE, findFileRefs, splitFileText } from "./fileRefs";

describe("findFileRefs（文件路径识别）", () => {
  it("识别 src/foo.ts:12（路径+行号）", () => {
    const refs = findFileRefs("读取 src/foo.ts:12 的内容");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: "src/foo.ts", line: 12, column: null });
  });

  it("识别 ./相对、~/、/绝对、多段与 path:line:col", () => {
    expect(findFileRefs("./web/src/App.tsx")[0].path).toBe("./web/src/App.tsx");
    expect(findFileRefs("~/Workspace/agent-hub/server/src/git.ts")[0].path).toBe(
      "~/Workspace/agent-hub/server/src/git.ts",
    );
    expect(findFileRefs("/Users/me/Workspace/a/b.ts:3:7")[0]).toMatchObject({
      path: "/Users/me/Workspace/a/b.ts",
      line: 3,
      column: 7,
    });
  });

  it("一行多个引用都识别，区间正确", () => {
    const text = "改 a/x.ts:1 和 b/y.md 吧";
    const refs = findFileRefs(text);
    expect(refs.map((r) => r.path)).toEqual(["a/x.ts", "b/y.md"]);
    expect(text.slice(refs[0].start, refs[0].end)).toBe("a/x.ts:1");
    expect(text.slice(refs[1].start, refs[1].end)).toBe("b/y.md");
  });

  it("不误识别 URL / 纯单词 / 无扩展名 / flag 参数", () => {
    expect(findFileRefs("见 https://example.com/a.js?v=1")).toEqual([]);
    expect(findFileRefs("执行 git diff 看看")).toEqual([]);
    expect(findFileRefs("目录 src/components/ 有变化")).toEqual([]);
    expect(findFileRefs("运行 --cwd=/tmp/x 试试")).toEqual([]);
  });

  it("正则字面量可独立使用（FILE_REF_RE 有全局标记，重置后可复用）", () => {
    FILE_REF_RE.lastIndex = 0;
    const m = FILE_REF_RE.exec("open server/src/git.ts:42 now");
    expect(m?.[1]).toBe("server/src/git.ts");
    expect(m?.[2]).toBe("42");
    FILE_REF_RE.lastIndex = 0;
  });
});

describe("splitFileText（渲染切分）", () => {
  it("切成 文本段/引用段，还原原文", () => {
    const text = "先看 src/foo.ts:12 再看 docs/API_CONTRACT.md";
    const parts = splitFileText(text);
    expect(parts.filter((p) => p.kind === "ref")).toHaveLength(2);
    expect(parts.map((p) => p.value).join("")).toBe(text);
  });

  it("无引用时只有纯文本段", () => {
    expect(splitFileText("没有路径")).toEqual([{ kind: "text", value: "没有路径" }]);
  });
});
