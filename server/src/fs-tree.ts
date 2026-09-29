/**
 * 只读文件树（GET /api/fs/tree，docs/API_CONTRACT.md §9）。
 *
 * 硬约束：
 * - 只读：仅 readdir + stat，无任何写入口。
 * - 防路径穿越：cwd 必须是存在的绝对目录；path 参数 resolve 后必须仍在 cwd 内
 *   （与 git.ts 的 resolveInsideRepo 同口径：resolve 级校验，不展开符号链接）。
 * - 单层列表：一次只列一个目录的直接子项（子目录 + 文件），深度/条目双上限。
 * - `.git` / `node_modules` / 点开头项默认隐藏，`?hidden=1` 展开（展开只是列表可见，
 *   仍然只读、仍在 cwd 内）。
 * - `?q=` 文件名大小写不敏感子串过滤。
 */
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCodes, HubError } from "./errors.js";
import type { FsEntryDto, FsTreeDto, FsEntryType } from "./types.js";

/** 单层最大条目数 */
export const MAX_ENTRIES = 500;
/** 最大目录深度（相对 cwd 的分段数） */
export const MAX_DEPTH = 24;
/** q 过滤词长度上限 */
export const MAX_QUERY = 128;

/** 可注入的 fs 子集（测试 fake） */
export interface FsTreeFsLike {
  readdir(dir: string): Promise<import("node:fs").Dirent[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
}

const defaultFs: FsTreeFsLike = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  stat,
};

/** 默认隐藏规则：点开头（.git 等）或 node_modules */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** 绝对路径判定（POSIX / Windows），与 git.ts 口径一致 */
function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** path 参数 resolve 到 cwd 内；越界抛 INVALID_PATH（防 `../` 穿越） */
export function resolveInsideCwd(cwd: string, target: string): string {
  const abs = resolve(cwd, target);
  const rel = relative(cwd, abs);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new HubError(ErrorCodes.INVALID_PATH, `路径越出 cwd: ${target}`, 400);
  }
  return abs;
}

/** 相对路径段数（深度上限用） */
export function pathDepth(relPath: string): number {
  return relPath.split(/[\\/]/).filter((s) => s !== "").length;
}

export interface ListDirOptions {
  /** 相对 cwd 的目录路径（"" = 根） */
  path?: string;
  /** 文件名过滤（大小写不敏感子串） */
  q?: string;
  /** 是否显示默认隐藏项（.git/node_modules/点开头） */
  hidden?: boolean;
}

/** 排序：目录优先，再按名字大小写不敏感 */
function compareEntries(a: FsEntryDto, b: FsEntryDto): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * 列目录（单层、只读、上限截断）。非法 cwd → INVALID_CWD 400；
 * cwd 不存在/非目录 → FILE_NOT_FOUND 404；越界 path → INVALID_PATH 400。
 */
export async function listDir(
  cwd: string,
  options: ListDirOptions = {},
  fsLike: FsTreeFsLike = defaultFs,
): Promise<FsTreeDto> {
  if (typeof cwd !== "string" || cwd.trim() === "" || !isAbsolutePath(cwd)) {
    throw new HubError(ErrorCodes.INVALID_CWD, `cwd 必须是绝对路径: ${String(cwd).slice(0, 120)}`, 400);
  }
  const root = resolve(cwd);
  let rootStat: { isDirectory(): boolean };
  try {
    rootStat = await fsLike.stat(root);
  } catch {
    throw new HubError(ErrorCodes.FILE_NOT_FOUND, `cwd 不存在: ${root}`, 404);
  }
  if (!rootStat.isDirectory()) {
    throw new HubError(ErrorCodes.FILE_NOT_FOUND, `cwd 不是目录: ${root}`, 404);
  }

  const relPathRaw = typeof options.path === "string" ? options.path : "";
  const absDir = resolveInsideCwd(root, relPathRaw);
  const relPath = relative(root, absDir);
  if (pathDepth(relPath) > MAX_DEPTH) {
    throw new HubError(ErrorCodes.INVALID_PATH, `目录深度超过上限 ${MAX_DEPTH}`, 400);
  }

  const query = typeof options.q === "string" ? options.q.trim().slice(0, MAX_QUERY).toLowerCase() : "";
  const showHidden = options.hidden === true;

  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fsLike.readdir(absDir);
  } catch {
    throw new HubError(ErrorCodes.FILE_NOT_FOUND, `目录不存在: ${relPath === "" ? "." : relPath}`, 404);
  }

  const entries: FsEntryDto[] = [];
  let truncated = false;
  for (const entry of dirEntries) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const hidden = isHiddenName(entry.name);
    if (hidden && !showHidden) continue;
    if (query !== "" && !entry.name.toLowerCase().includes(query)) continue;
    const type: FsEntryType = entry.isDirectory() ? "dir" : "file";
    let size: number | null = null;
    if (type === "file") {
      try {
        size = (await fsLike.stat(join(absDir, entry.name))).size;
      } catch {
        size = null; // 竞态消失/无权限：不阻塞列表
      }
    }
    entries.push({ name: entry.name, type, hidden, size });
  }
  entries.sort(compareEntries);

  // parent：根 → null；否则上一层相对路径（"" 表示回到根）
  const parent =
    relPath === ""
      ? null
      : relPath.includes("/")
        ? relPath.slice(0, relPath.lastIndexOf("/"))
        : relPath.includes("\\")
          ? relPath.slice(0, relPath.lastIndexOf("\\"))
          : "";

  return {
    cwd: root,
    path: relPath.split(sep).join("/"),
    parent: parent === null ? null : parent.split(sep).join("/"),
    entries,
    truncated,
  };
}
