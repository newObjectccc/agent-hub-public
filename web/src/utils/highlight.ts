/**
 * 轻量语法高亮（不引重型库）：三色即可 —— 关键字 / 字符串 / 注释。
 * 输入是 escapeHtml 之后的代码文本（`"` → `&quot;`，`'` → `&#39;`），
 * 输出插入 <span class="tok-kw|tok-str|tok-com"> 的 HTML 片段。
 *
 * 语言无关的粗规则（够用即可，不做完整 tokenizer）：
 * - 字符串："…" / '…' / `…`（含转义）
 * - 注释：//… 、 /* … *\/（可跨行）、行首 #…（shell/python 整行注释；
 *   行中 # 不当注释，避免 CSS 颜色 #fff 误伤）
 * - 关键字：常见 JS/TS/Python/Java/Go/Rust/SQL 关键字集合
 */

const KEYWORDS = new Set([
  // JS / TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "break", "continue",
  "class", "extends", "new", "this", "super", "import", "export", "from", "as", "async", "await", "try",
  "catch", "finally", "throw", "switch", "case", "default", "typeof", "instanceof", "in", "of", "void",
  "delete", "yield", "static", "get", "set", "interface", "type", "enum", "implements", "public",
  "private", "protected", "readonly", "declare", "namespace", "satisfies",
  // Python
  "def", "elif", "except", "lambda", "pass", "raise", "with", "global", "nonlocal", "assert", "class_",
  // Java / Go / Rust / C 系
  "package", "func", "struct", "impl", "trait", "match", "mod", "use", "pub", "mut", "defer", "goto",
  "sizeof", "typedef", "enum_", "union", "template", "typename", "nullptr", "boolean", "byte", "short",
  "long", "float", "double", "char", "unsigned", "signed",
  // 通用
  "true", "false", "null", "undefined", "None", "True", "False", "self", "print", "echo",
]);

/**
 * 转义后代码 → 高亮 HTML。
 * 单次扫描（字符串/注释优先吞并，关键字兜底），行首 # 注释带上前置换行一起匹配后原样回吐。
 */
export function highlightCode(escaped: string): string {
  const token =
    /(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?:^|\n)[ \t]*#[^\n]*)|([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(escaped)) !== null) {
    out += escaped.slice(last, m.index);
    last = token.lastIndex;
    if (m[1] !== undefined) {
      const raw = m[1];
      const lead = raw.startsWith("\n") ? "\n" : "";
      const body = lead === "" ? raw : raw.slice(1);
      const isString = /^(&quot;|&#39;|`)/.test(body);
      out += `${lead}<span class="${isString ? "tok-str" : "tok-com"}">${body}</span>`;
    } else {
      const word = m[2];
      out += KEYWORDS.has(word) ? `<span class="tok-kw">${word}</span>` : word;
    }
  }
  out += escaped.slice(last);
  return out;
}
