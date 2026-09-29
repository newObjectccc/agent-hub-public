/**
 * unified diff 解析与渲染辅助（纯函数，供 DiffView 使用）。
 * 支持：多文件（diff --git）、新增/删除文件、@@ hunk、+/-/context 行号、binary、"\ No newline"。
 */

export type DiffLineType = "meta" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** 去掉 +/-/空前缀后的行文本 */
  text: string;
  /** 原始前缀（+/-/空/@/\） */
  prefix: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  /** 新路径（重命名取新名，删除文件取旧名） */
  path: string;
  oldPath: string | null;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function unquoteGitPath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** 解析 unified diff 原文 → 按文件分组（未知行按 meta 处理，如 commit 头/ mode 行） */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = (file: DiffFile | null): void => {
    if (file) files.push(file);
  };

  for (const rawLine of raw.split("\n")) {
    if (rawLine === "" && current === null) continue;

    const gitHeader = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitHeader) {
      push(current);
      current = {
        path: unquoteGitPath(gitHeader[2]),
        oldPath: unquoteGitPath(gitHeader[1]),
        lines: [],
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false,
      };
      continue;
    }

    if (current === null) {
      // 文件头之前的 preamble（如 git show 的 commit 信息）：忽略
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      const p = unquoteGitPath(rawLine.slice(4));
      current.oldPath = p === "/dev/null" ? null : stripPrefix(p);
      if (p === "/dev/null") current.isNew = true;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const p = unquoteGitPath(rawLine.slice(4));
      if (p === "/dev/null") {
        current.isDeleted = true;
      } else {
        current.path = stripPrefix(p);
      }
      continue;
    }
    if (rawLine.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (rawLine.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (rawLine.startsWith("Binary files")) {
      current.isBinary = true;
      current.lines.push({ type: "meta", text: rawLine, prefix: "", oldNo: null, newNo: null });
      continue;
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      current.lines.push({ type: "hunk", text: rawLine, prefix: "@", oldNo: null, newNo: null });
      continue;
    }

    const prefix = rawLine.slice(0, 1);
    if (prefix === "+") {
      current.additions += 1;
      current.lines.push({ type: "add", text: rawLine.slice(1), prefix: "+", oldNo: null, newNo: newNo++ });
    } else if (prefix === "-") {
      current.deletions += 1;
      current.lines.push({ type: "del", text: rawLine.slice(1), prefix: "-", oldNo: oldNo++, newNo: null });
    } else if (prefix === " " || rawLine === "") {
      current.lines.push({ type: "context", text: rawLine.slice(1), prefix: " ", oldNo: oldNo++, newNo: newNo++ });
    } else {
      // "\ No newline at end of file"、"index …"、"old mode" 等
      current.lines.push({ type: "meta", text: rawLine, prefix, oldNo: null, newNo: null });
    }
  }
  push(current);
  return files;
}

/** 渲染：diff 行类型 → CSS 类名 */
export function diffLineClass(type: DiffLineType): string {
  switch (type) {
    case "add":
      return "dl add";
    case "del":
      return "dl del";
    case "hunk":
      return "dl hunk";
    case "meta":
      return "dl meta";
    default:
      return "dl ctx";
  }
}

/** 全量统计（DiffView 头部徽章） */
export function countChanges(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}
