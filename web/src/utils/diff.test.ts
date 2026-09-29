/**
 * unified diff 解析/渲染函数单测（DiffView 的数据层）。
 */
import { describe, expect, it } from "vitest";
import { countChanges, diffLineClass, parseDiff, type DiffLineType } from "./diff";

const SAMPLE = [
  "commit 1234abc (from git show preamble，应被忽略)",
  "Author: peter",
  "",
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "\\ No newline at end of file",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,2 @@",
  "+hello",
  "+world",
  "diff --git a/gone.bin b/gone.bin",
  "deleted file mode 100644",
  "Binary files a/gone.bin and b/gone.bin differ",
].join("\n");

describe("parseDiff", () => {
  it("按文件分组，统计 +/-，识别新增/删除/二进制", () => {
    const files = parseDiff(SAMPLE);
    expect(files).toHaveLength(3);

    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].oldPath).toBe("src/foo.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].isNew).toBe(false);

    expect(files[1].path).toBe("new.txt");
    expect(files[1].isNew).toBe(true);
    expect(files[1].oldPath).toBeNull();
    expect(files[1].additions).toBe(2);

    expect(files[2].path).toBe("gone.bin");
    expect(files[2].isDeleted).toBe(true);
    expect(files[2].isBinary).toBe(true);
  });

  it("hunk 行号递增：context 双号、add 只新号、del 只旧号", () => {
    const files = parseDiff(SAMPLE);
    const lines = files[0].lines;
    // hunk 之后的行：context/del/add/…/No newline
    const hunkIdx = lines.findIndex((l) => l.type === "hunk");
    expect(hunkIdx).toBeGreaterThan(-1);
    const content = lines.slice(hunkIdx + 1);
    expect(content.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["meta", null, null], // \ No newline
    ]);
  });

  it("git show 的 commit preamble 不产生伪文件", () => {
    const files = parseDiff("commit abc\nAuthor: x\n\ndiff --git a/x b/x\n@@ -0,0 +1 @@\n+y\n");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("x");
    expect(files[0].additions).toBe(1);
  });

  it("空输入/无 diff 段返回 []", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("just some text")).toEqual([]);
  });

  it("countChanges 全量统计", () => {
    const totals = countChanges(parseDiff(SAMPLE));
    expect(totals).toEqual({ files: 3, additions: 4, deletions: 1 });
  });
});

describe("diffLineClass（渲染类名）", () => {
  it("每种行类型映射到稳定 CSS 类", () => {
    const expected: Record<DiffLineType, string> = {
      add: "dl add",
      del: "dl del",
      hunk: "dl hunk",
      meta: "dl meta",
      context: "dl ctx",
    };
    for (const [type, cls] of Object.entries(expected)) {
      expect(diffLineClass(type as DiffLineType)).toBe(cls);
    }
  });
});
