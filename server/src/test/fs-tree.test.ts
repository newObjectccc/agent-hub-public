/**
 * 只读文件树（server/src/fs-tree.ts）单测：
 * - 列目录：排序（目录优先）、hidden 开关、q 过滤、parent/path 导航
 * - 防路径穿越：../ 越界、非法 cwd、不存在 cwd、深度上限
 * - 条目上限截断
 */
import { strict as assert } from "node:assert";
import type { Dirent } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_DEPTH, MAX_ENTRIES, isHiddenName, listDir, pathDepth, resolveInsideCwd } from "../fs-tree.js";

function dirent(name: string, kind: "file" | "dir"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  } as unknown as Dirent;
}

describe("fs-tree: 纯函数", () => {
  it("isHiddenName：点开头与 node_modules 隐藏", () => {
    assert.equal(isHiddenName(".git"), true);
    assert.equal(isHiddenName("node_modules"), true);
    assert.equal(isHiddenName("src"), false);
    assert.equal(isHiddenName("README.md"), false);
  });

  it("resolveInsideCwd：根内放行、越界抛 INVALID_PATH", () => {
    assert.equal(resolveInsideCwd("/root", "a/b"), resolve("/root/a/b"));
    assert.equal(resolveInsideCwd("/root", ""), resolve("/root"));
    assert.throws(() => resolveInsideCwd("/root", "../etc/passwd"), { code: "INVALID_PATH" });
    assert.throws(() => resolveInsideCwd("/root", "a/../../.."), { code: "INVALID_PATH" });
  });

  it("pathDepth", () => {
    assert.equal(pathDepth(""), 0);
    assert.equal(pathDepth("a/b/c"), 3);
  });
});

describe("fs-tree: listDir（真实临时目录）", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-fs-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "README.md"), "# hi");
    await writeFile(join(root, "zzz.txt"), "z");
    await writeFile(join(root, "src", "app.ts"), "export {}");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("默认隐藏 .git/node_modules，目录优先排序", async () => {
    const tree = await listDir(root);
    assert.equal(tree.path, "");
    assert.equal(tree.parent, null);
    assert.equal(tree.truncated, false);
    const names = tree.entries.map((e) => e.name);
    assert.deepEqual(names, ["src", "README.md", "zzz.txt"]);
    assert.equal(tree.entries[0].type, "dir");
    assert.equal(tree.entries[0].size, null);
    assert.equal(tree.entries[1].size, 4);
  });

  it("hidden=1 展开 .git/node_modules（标 hidden）", async () => {
    const tree = await listDir(root, { hidden: true });
    const names = tree.entries.map((e) => e.name);
    assert.ok(names.includes(".git"));
    assert.ok(names.includes("node_modules"));
    assert.equal(tree.entries.find((e) => e.name === ".git")?.hidden, true);
  });

  it("q 大小写不敏感子串过滤", async () => {
    const tree = await listDir(root, { q: "readme" });
    assert.deepEqual(tree.entries.map((e) => e.name), ["README.md"]);
  });

  it("进入子目录：path/parent 正确", async () => {
    const tree = await listDir(root, { path: "src" });
    assert.equal(tree.path, "src");
    assert.equal(tree.parent, "");
    assert.deepEqual(tree.entries.map((e) => e.name), ["deep", "app.ts"]);
  });

  it("防穿越：path=../ 与绝对路径越界 → INVALID_PATH 400", async () => {
    await assert.rejects(listDir(root, { path: "../" }), { code: "INVALID_PATH" });
    await assert.rejects(listDir(root, { path: ".." }), { code: "INVALID_PATH" });
    await assert.rejects(listDir(root, { path: "src/../../etc" }), { code: "INVALID_PATH" });
  });

  it("非法 cwd → INVALID_CWD 400；不存在/非目录 → FILE_NOT_FOUND 404", async () => {
    await assert.rejects(listDir("relative/path"), { code: "INVALID_CWD" });
    await assert.rejects(listDir(""), { code: "INVALID_CWD" });
    await assert.rejects(listDir(join(root, "no-such-dir")), { code: "FILE_NOT_FOUND" });
    await assert.rejects(listDir(join(root, "README.md")), { code: "FILE_NOT_FOUND" });
  });

  it("深度上限：超 MAX_DEPTH → INVALID_PATH", async () => {
    const deep = Array.from({ length: MAX_DEPTH + 1 }, () => "x").join("/");
    await assert.rejects(listDir(root, { path: deep }), { code: "INVALID_PATH" });
    const ok = Array.from({ length: MAX_DEPTH }, () => "x").join("/");
    // 不存在的深层路径 → FILE_NOT_FOUND（深度本身放行）
    await assert.rejects(listDir(root, { path: ok }), { code: "FILE_NOT_FOUND" });
  });
});

describe("fs-tree: listDir 条目上限（fake fs）", () => {
  it("超过 MAX_ENTRIES 截断并 truncated=true", async () => {
    const entries = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => dirent(`f${String(i).padStart(4, "0")}.md`, "file"));
    const fsLike = {
      async readdir() {
        return entries;
      },
      async stat() {
        return { isDirectory: () => true, isFile: () => true, size: 1 };
      },
    };
    const tree = await listDir("/any/abs", {}, fsLike);
    assert.equal(tree.entries.length, MAX_ENTRIES);
    assert.equal(tree.truncated, true);
  });

  it("过滤后不足上限不算截断", async () => {
    const entries = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => dirent(`f${String(i).padStart(4, "0")}.md`, "file"));
    const fsLike = {
      async readdir() {
        return entries;
      },
      async stat() {
        return { isDirectory: () => true, isFile: () => true, size: 1 };
      },
    };
    const tree = await listDir("/any/abs", { q: "f0001" }, fsLike);
    assert.equal(tree.entries.length, 1);
    assert.equal(tree.truncated, false);
  });
});
