#!/usr/bin/env node
/**
 * mirror.js：claude 会话投屏渲染器（hub 驱动接管，docs/CLAUDE_DRIVER.md D7）。
 * 单文件零依赖：渲染 transcript 历史 + watch 追加行，ANSI 着色人类可读输出。
 * 用法：node cli/mirror.js --file <session.jsonl> --label <sessionId>
 * 退出：tmux kill-session（SIGHUP）→ 打印 resume 提示后退出（best-effort）。
 * 安全：内容一律剥 ANSI 转义与控制字符（防终端注入），纯文本上屏。
 */
import { createReadStream, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";

const args = process.argv.slice(2);
function argOf(name, fallback = "") {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const file = argOf("--file");
const label = argOf("--label", "session");
if (file === "") {
  console.error("usage: mirror.js --file <session.jsonl> [--label <sessionId>]");
  process.exit(1);
}

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

/** 防终端注入：剥 ANSI/控制字符（保留 \n 与可打印 Unicode） */
function sanitize(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function clip(s, n = 600) {
  const t = sanitize(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function renderLine(raw) {
  if (raw.trim() === "") return;
  let row = null;
  try {
    row = JSON.parse(raw);
  } catch {
    return;
  }
  const t = row.type;
  if (t === "ai-title" && typeof row.aiTitle === "string") {
    console.log(`${C.bold}📋 ${clip(row.aiTitle, 80)}${C.reset}`);
  } else if (t === "user") {
    const content = row.message?.content;
    if (typeof content === "string") {
      console.log(`\n${C.cyan}❯ ${clip(content)}${C.reset}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          const preview = clip(typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""), 120);
          console.log(`${C.dim}  ↳ ${block.is_error ? "✗" : "✓"} ${preview}${C.reset}`);
        } else if (typeof block?.text === "string") {
          console.log(`\n${C.cyan}❯ ${clip(block.text)}${C.reset}`);
        }
      }
    }
  } else if (t === "assistant") {
    for (const block of row.message?.content ?? []) {
      if (block?.type === "text") {
        console.log(`${C.green}${clip(block.text, 4000)}${C.reset}`);
      } else if (block?.type === "tool_use") {
        const summary = clip(
          typeof block.input?.command === "string"
            ? block.input.command
            : typeof block.input?.file_path === "string"
              ? block.input.file_path
              : "",
          100,
        );
        console.log(`${C.yellow}⚙ ${clip(block.name ?? "tool", 40)} ${summary}${C.reset}`);
      } else if (block?.type === "thinking") {
        // 思维链不实时刷屏：一行占位
        console.log(`${C.dim}… thinking${C.reset}`);
      }
    }
  } else if (t === "result") {
    console.log(`${C.dim}── turn ${row.subtype ?? "end"} ──${C.reset}`);
  }
}

console.log(`${C.bold}🖥 agent-hub 投屏${C.reset} ${C.dim}(${sanitize(label)})${C.reset}`);
console.log(`${C.dim}实时显示接管会话输出；退出接管后运行: claude --resume ${sanitize(label)}${C.reset}\n`);

// 历史：整文件一次读（行缓冲）
let offset = 0;
let residual = "";
function consume(chunk) {
  residual += chunk;
  let idx = residual.indexOf("\n");
  while (idx >= 0) {
    const line = residual.slice(0, idx);
    residual = residual.slice(idx + 1);
    idx = residual.indexOf("\n");
    renderLine(line);
  }
}

if (existsSync(file)) {
  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("data", (chunk) => {
    offset += Buffer.byteLength(chunk);
    consume(chunk);
  });
  stream.on("end", () => startTail());
} else {
  startTail();
}

function startTail() {
  // 追加 tail：500ms 轮询 stat（零依赖、跨平台稳）。
  // 注意：不 unref——投屏是常驻进程，必须由该定时器保活（否则历史读完即退出）
  let size = existsSync(file) ? statSync(file).size : 0;
  if (size < offset) size = offset; // 文件被截断/轮转：从当前读到的位置继续
  setInterval(() => {
    if (!existsSync(file)) return;
    const st = statSync(file);
    if (st.size > size) {
      const fd = openSync(file, "r");
      const buf = Buffer.alloc(st.size - size);
      readSync(fd, buf, 0, buf.length, size);
      closeSync(fd);
      size = st.size;
      consume(String(buf));
    } else if (st.size < size) {
      size = st.size;
    }
  }, 500);
}

// tmux kill-session → SIGHUP：best-effort 打印交接提示
for (const sig of ["SIGHUP", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(
      `\n${C.bold}已退出接管${C.reset}——电脑上运行 ${C.cyan}claude --resume ${sanitize(label)}${C.reset} 继续该会话`,
    );
    process.exit(0);
  });
}
