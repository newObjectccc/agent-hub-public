/**
 * 工具调用文本里的文件路径识别（纯函数 + 正则，供 ToolCallCard 文件联动使用）。
 * 识别 `src/foo.ts`、`./a/b.ts`、`/abs/x.ts`、`src/foo.ts:12`、`src/foo.ts:12:5`；
 * 不识别 URL（https://…）、纯单词、无扩展名的目录。
 */

export interface FileRef {
  path: string;
  line: number | null;
  column: number | null;
  /** 在原文本中的区间 [start, end) */
  start: number;
  end: number;
}

/**
 * 文件路径正则：
 * - 至少含一个 `/`（目录段 + 文件名），文件名必须带 1-8 位扩展名
 * - 前置负向断言：不从 URL/单词/点号中间起匹配（`https://x.com/a.js` 不命中）
 * - 可选 `:line`、`:line:col` 后缀
 */
export const FILE_REF_RE =
  /(?<![\w@/.\\])((?:~\/|\.\.?\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})(?::(\d{1,6}))?(?::(\d{1,6}))?(?![\w./])/g;

export function findFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  const re = new RegExp(FILE_REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    // 剔除以 `-` 结尾的伪路径（如 flag --cwd=/x）与纯符号
    if (/[-._/]$/.test(path)) continue;
    refs.push({
      path,
      line: m[2] !== undefined ? Number(m[2]) : null,
      column: m[3] !== undefined ? Number(m[3]) : null,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return refs;
}

export type FileTextPart =
  | { kind: "text"; value: string }
  | { kind: "ref"; value: string; ref: FileRef };

/** 把文本切成 普通段 / 文件引用段（渲染成可点击链接用） */
export function splitFileText(text: string): FileTextPart[] {
  const refs = findFileRefs(text);
  const parts: FileTextPart[] = [];
  let pos = 0;
  for (const ref of refs) {
    if (ref.start > pos) parts.push({ kind: "text", value: text.slice(pos, ref.start) });
    parts.push({ kind: "ref", value: text.slice(ref.start, ref.end), ref });
    pos = ref.end;
  }
  if (pos < text.length) parts.push({ kind: "text", value: text.slice(pos) });
  return parts;
}
