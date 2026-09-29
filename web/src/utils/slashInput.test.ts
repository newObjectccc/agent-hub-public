import { describe, expect, it } from "vitest";
import {
  applyCommandInsert,
  applyFileInsert,
  detectCommandTrigger,
  detectToken,
  filterSlashCommands,
  type SlashCommandLike,
} from "./slashInput";

const commands: SlashCommandLike[] = [
  { name: "/name", description: "设置会话显示名", builtin: true, terminalOnly: false },
  { name: "/compact", description: "压缩当前上下文", builtin: true, terminalOnly: false },
  { name: "/clear", description: "清空上下文", builtin: true, terminalOnly: true },
  { name: "/e2e", description: "Open a web page", builtin: false, terminalOnly: false },
];

describe("slashInput: detectCommandTrigger", () => {
  it("行首 / 或空白后 / 触发；query = 光标前 token 的 / 之后部分", () => {
    expect(detectCommandTrigger("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(detectCommandTrigger("/na", 3)).toEqual({ start: 0, end: 3, query: "na" });
    expect(detectCommandTrigger("你好 /na", 6)).toEqual({ start: 3, end: 6, query: "na" });
  });

  it("token 含空白 / 非 / 开头 / 光标越界 → null", () => {
    expect(detectCommandTrigger("/a b", 4)).toBeNull();
    expect(detectCommandTrigger("abc", 3)).toBeNull();
    expect(detectCommandTrigger("x/y", 3)).toBeNull();
    expect(detectCommandTrigger("hi", 99)).toBeNull();
  });
});

describe("slashInput: detectToken（@ 文件引用）", () => {
  it("@ 起 token 检测与过滤词", () => {
    expect(detectToken("@src/", 5, "@")).toEqual({ start: 0, end: 5, query: "src/" });
    expect(detectToken("看 @ab", 5, "@")).toEqual({ start: 2, end: 5, query: "ab" });
    expect(detectToken("email@x", 7, "@")).toBeNull();
    expect(detectToken("@a b", 4, "@")).toBeNull();
  });
});

describe("slashInput: filterSlashCommands", () => {
  it("空 query 全量；否则名字或描述大小写不敏感子串命中", () => {
    expect(filterSlashCommands(commands, "").length).toBe(4);
    expect(filterSlashCommands(commands, "NAME").map((c) => c.name)).toEqual(["/name"]);
    expect(filterSlashCommands(commands, "压缩").map((c) => c.name)).toEqual(["/compact"]);
    expect(filterSlashCommands(commands, "web").map((c) => c.name)).toEqual(["/e2e"]);
    expect(filterSlashCommands(commands, "zzz-none").length).toBe(0);
  });
});

describe("slashInput: 插入", () => {
  it("applyCommandInsert：替换 /token 为 `/cmd `，光标落在其后", () => {
    const span = detectCommandTrigger("/na", 3);
    expect(span).not.toBeNull();
    const result = applyCommandInsert("/na", span!, "/name");
    expect(result.text).toBe("/name ");
    expect(result.cursor).toBe(6);
  });

  it("applyCommandInsert：保留前后文", () => {
    const text = "请看 /na 后面";
    const span = detectCommandTrigger(text, 6);
    expect(span).not.toBeNull();
    const result = applyCommandInsert(text, span!, "/name");
    expect(result.text).toBe("请看 /name  后面");
  });

  it("applyFileInsert：多选插入 `@p1 @p2 `，去掉重复 @ 前缀", () => {
    const span = detectToken("@src/", 5, "@");
    expect(span).not.toBeNull();
    const result = applyFileInsert("@src/", span!, ["src/a.ts", "@src/b.ts"]);
    expect(result.text).toBe("@src/a.ts @src/b.ts ");
    expect(result.cursor).toBe(result.text.length);
  });

  it("applyFileInsert：无选中只替换掉触发 token", () => {
    const span = detectToken("@", 1, "@");
    expect(span).not.toBeNull();
    expect(applyFileInsert("@", span!, []).text).toBe("");
  });

  it("applyCommandInsert：span 为光标处空 token 时按位置替换", () => {
    const result = applyCommandInsert("abc", { start: 3, end: 3, query: "" }, "/name");
    expect(result.text).toBe("abc/name ");
  });
});
