/**
 * slash 命令清单（server/src/commands.ts）单测：
 * - pi/claude 内置清单完整性与 terminalOnly 语义
 * - 自定义命令扫描（fake fs）：命名、description、容错、上限
 */
import { strict as assert } from "node:assert";
import type { Dirent } from "node:fs";
import { describe, it } from "node:test";
import {
  CLAUDE_BUILTIN_COMMANDS,
  DESCRIPTION_LIMIT,
  PI_BUILTIN_COMMANDS,
  createCommandsApi,
  extractDescription,
  scanClaudeCustomCommands,
  type CommandFsLike,
} from "../commands.js";

function dirent(name: string, kind: "file" | "dir"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  } as unknown as Dirent;
}

function fakeFs(tree: Record<string, { entries?: Dirent[]; content?: string; failRead?: boolean }>): CommandFsLike {
  return {
    async readdir(dir) {
      const node = tree[dir];
      if (!node?.entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return node.entries;
    },
    async readFile(path) {
      const node = tree[path];
      if (!node || node.failRead) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return node.content ?? "";
    },
    async stat() {
      return { isDirectory: () => true, isFile: () => true };
    },
  };
}

describe("commands: 内置清单", () => {
  it("pi 清单：25 条内置命令、名字唯一且带 /、全部可发送", () => {
    assert.equal(PI_BUILTIN_COMMANDS.length, 25);
    const names = new Set<string>();
    for (const cmd of PI_BUILTIN_COMMANDS) {
      assert.match(cmd.name, /^\/[a-z][a-z-]*$/, cmd.name);
      assert.ok(!names.has(cmd.name), `重复命令 ${cmd.name}`);
      names.add(cmd.name);
      assert.ok(cmd.description.length > 0, cmd.name);
      assert.equal(cmd.builtin, true);
      assert.equal(cmd.terminalOnly, false);
    }
    // 任务点名的命令必须在列
    for (const required of ["/resume", "/new", "/compact", "/fork", "/tree", "/export", "/session", "/name", "/bug"]) {
      assert.ok(names.has(required), `缺少 ${required}`);
    }
  });

  it("claude 清单：内置全部 terminalOnly=true（print 模式实测不可用）", () => {
    assert.ok(CLAUDE_BUILTIN_COMMANDS.length >= 15);
    const names = new Set<string>();
    for (const cmd of CLAUDE_BUILTIN_COMMANDS) {
      assert.match(cmd.name, /^\/[a-z][a-z-]*$/, cmd.name);
      assert.ok(!names.has(cmd.name), `重复命令 ${cmd.name}`);
      names.add(cmd.name);
      assert.equal(cmd.builtin, true);
      assert.equal(cmd.terminalOnly, true, cmd.name);
    }
    for (const required of ["/clear", "/compact", "/config"]) {
      assert.ok(names.has(required), `缺少 ${required}`);
    }
  });
});

describe("commands: extractDescription", () => {
  it("frontmatter description 优先", () => {
    const content = "---\ndescription: 打开一个页面并验证\nallowed-tools: x\n---\n\n# 标题\n正文";
    assert.equal(extractDescription(content), "打开一个页面并验证");
  });

  it("无 frontmatter 取首个文本行（标题去 #）", () => {
    assert.equal(extractDescription("# E2E 验证\n\n正文"), "E2E 验证");
    assert.equal(extractDescription("\n\n正文第一行\n更多"), "正文第一行");
  });

  it("描述超长截断加省略号", () => {
    const long = "x".repeat(DESCRIPTION_LIMIT + 20);
    const out = extractDescription(`---\ndescription: ${long}\n---`);
    assert.equal(out.length, DESCRIPTION_LIMIT + 1);
    assert.ok(out.endsWith("…"));
  });
});

describe("commands: scanClaudeCustomCommands", () => {
  it("根 md → /name，子目录 md → /dir:name；非法名与读失败跳过", async () => {
    const dir = "/home/u/.claude/commands";
    const fsLike = fakeFs({
      [dir]: {
        entries: [
          dirent("e2e.md", "file"),
          dirent("bad name.md", "file"),
          dirent("nope.txt", "file"),
          dirent("review", "dir"),
          dirent(".hidden", "dir"),
        ],
      },
      [`${dir}/e2e.md`]: { content: "---\ndescription: 打开页面验证\n---\n# T" },
      [`${dir}/review`]: { entries: [dirent("pr.md", "file")] },
      [`${dir}/review/pr.md`]: { content: "# Review PR\n正文" },
    });
    const cmds = await scanClaudeCustomCommands(dir, fsLike);
    assert.deepEqual(
      cmds.map((c) => c.name),
      ["/e2e", "/review:pr"],
    );
    assert.equal(cmds[0].description, "打开页面验证");
    assert.equal(cmds[1].description, "Review PR");
    assert.equal(cmds[0].builtin, false);
    assert.equal(cmds[0].terminalOnly, false);
  });

  it("目录不存在降级空列表，绝不抛错", async () => {
    assert.deepEqual(await scanClaudeCustomCommands("/no/such/dir", fakeFs({})), []);
  });

  it("单文件读失败跳过不影响其余", async () => {
    const dir = "/cmd";
    const fsLike = fakeFs({
      [dir]: { entries: [dirent("a.md", "file"), dirent("b.md", "file")] },
      [`${dir}/a.md`]: { failRead: true },
      [`${dir}/b.md`]: { content: "B 命令" },
    });
    const cmds = await scanClaudeCustomCommands(dir, fsLike);
    assert.deepEqual(cmds.map((c) => c.name), ["/b"]);
    assert.equal(cmds[0].description, "B 命令");
  });
});

describe("commands: createCommandsApi", () => {
  it("pi 只返回内置清单", async () => {
    const api = createCommandsApi(fakeFs({}), "/cmd");
    const list = await api.list("pi");
    assert.equal(list.source, "pi");
    assert.equal(list.commands.length, PI_BUILTIN_COMMANDS.length);
    assert.ok(list.commands.every((c) => c.builtin));
  });

  it("claude = 内置 + 自定义（内置在前）", async () => {
    const dir = "/cmd";
    const fsLike = fakeFs({
      [dir]: { entries: [dirent("zz.md", "file")] },
      [`${dir}/zz.md`]: { content: "ZZ" },
    });
    const api = createCommandsApi(fsLike, dir);
    const list = await api.list("claude");
    assert.equal(list.source, "claude");
    assert.equal(list.commands.length, CLAUDE_BUILTIN_COMMANDS.length + 1);
    assert.equal(list.commands.at(-1)?.name, "/zz");
  });
});
