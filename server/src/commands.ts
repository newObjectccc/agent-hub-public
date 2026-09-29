/**
 * Slash 命令清单（GET /api/commands?source=，docs/API_CONTRACT.md §8）。
 *
 * 调研结论（2026-02，真实 CLI + SDK 实测）：
 * - pi：SDK `prompt()` 只处理 **extension 命令 / /skill:name / prompt template**
 *   （sdk.md："prompt() handles extension commands"；源码 agent-session.prompt 证实）；
 *   **内置会话命令（/name /resume /tree …）不处理**——实测 `/name test` 被当普通消息发给
 *   模型。故内置清单（pi 文档 slash-commands.md 全量）除 `/compact` 外全部标记
 *   terminalOnly=true，UI 标注"仅终端可用"。`/compact [instructions]` 由 server 转发官方
 *   SDK `session.compact(instructions)`（prompt 路由特判，契约 §8）。
 * - claude：`claude -p` 对**自定义**命令（~/.claude/commands/*.md）会展开执行（实测 `/ping`
 *   正常输出）；对**内置**命令不可用（实测 `claude -p "/help"` →
 *   "/help isn't available in this environment."，`/compact` `/clear` 静默无输出）。
 *   故内置命令标记 terminalOnly=true，UI 标注"仅终端可用"，发送前给降级提示。
 *
 * 自定义命令扫描：~/.claude/commands/ 目录（含一层子目录）的 .md 文件（子目录 → `/dir:name`，与 Claude Code
 * 命名一致）；description 取 frontmatter `description:`，缺省取首个非空文本行截断。
 * 扫描失败（目录不存在/无权限）一律降级为空列表，绝不 500。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandDto, CommandListDto, SessionSource } from "./types.js";

/** 每个 source 的最大命令条数（防异常目录刷爆响应） */
export const MAX_COMMANDS = 300;
/** description 最大长度 */
export const DESCRIPTION_LIMIT = 120;
/** frontmatter / 正文扫描字节上限 */
const COMMAND_FILE_LIMIT = 16 * 1024;

/**
 * pi 内置命令（pi 文档 slash-commands.md 全量清单；description 为文档描述的中文转述）。
 * terminalOnly：SDK prompt() 通道不支持（会成普通消息）；仅 `/compact` 走 server 转发的
 * SDK session.compact() 真实可用。
 */
export const PI_BUILTIN_COMMANDS: readonly CommandDto[] = [
  // 模型与设置
  { name: "/settings", description: "打开设置", builtin: true, terminalOnly: true },
  { name: "/model", description: "选择模型（provider/model）", builtin: true, terminalOnly: true },
  { name: "/thinking", description: "设置思考等级（off…max）", builtin: true, terminalOnly: true },
  { name: "/scoped-models", description: "配置交互循环使用的模型", builtin: true, terminalOnly: true },
  { name: "/login", description: "添加 provider 认证", builtin: true, terminalOnly: true },
  { name: "/logout", description: "移除 provider 认证", builtin: true, terminalOnly: true },
  { name: "/llama", description: "管理 llama.cpp 路由上的模型", builtin: true, terminalOnly: true },
  // 会话与上下文
  { name: "/new", description: "开始新会话", builtin: true, terminalOnly: true },
  { name: "/resume", description: "切换到另一个已保存会话", builtin: true, terminalOnly: true },
  { name: "/name", description: "设置会话显示名（缺省显示当前名）", builtin: true, terminalOnly: true },
  { name: "/session", description: "显示当前会话信息与统计", builtin: true, terminalOnly: true },
  { name: "/tree", description: "导航会话树", builtin: true, terminalOnly: true },
  { name: "/fork", description: "从更早的用户消息创建新会话", builtin: true, terminalOnly: true },
  { name: "/clone", description: "复制当前会话到新会话", builtin: true, terminalOnly: true },
  { name: "/compact", description: "压缩当前上下文（可附保留指令）", builtin: true, terminalOnly: false },
  { name: "/import", description: "导入并恢复 JSONL 会话", builtin: true, terminalOnly: true },
  // 导出与分享
  { name: "/copy", description: "复制最后一条助手消息", builtin: true, terminalOnly: true },
  { name: "/export", description: "导出会话为 HTML/JSONL", builtin: true, terminalOnly: true },
  { name: "/share", description: "上传会话并返回查看链接", builtin: true, terminalOnly: true },
  { name: "/bug", description: "准备私密 bug 报告", builtin: true, terminalOnly: true },
  // 运行时与项目
  { name: "/trust", description: "保存项目信任决定", builtin: true, terminalOnly: true },
  { name: "/reload", description: "重新加载扩展/技能/模板/上下文", builtin: true, terminalOnly: true },
  { name: "/hotkeys", description: "显示快捷键", builtin: true, terminalOnly: true },
  { name: "/changelog", description: "显示更新日志", builtin: true, terminalOnly: true },
  { name: "/quit", description: "退出 pi", builtin: true, terminalOnly: true },
];

/**
 * claude 内置命令（交互 REPL 清单；全部 terminalOnly——`claude -p` 下不可用）。
 * 清单来自 Claude Code 官方 CLI/命令文档核实的常用内置集。
 */
export const CLAUDE_BUILTIN_COMMANDS: readonly CommandDto[] = [
  { name: "/clear", description: "清空会话上下文", builtin: true, terminalOnly: true },
  { name: "/compact", description: "压缩上下文（可附保留指令）", builtin: true, terminalOnly: true },
  { name: "/config", description: "打开配置面板", builtin: true, terminalOnly: true },
  { name: "/cost", description: "显示 token 用量与费用", builtin: true, terminalOnly: true },
  { name: "/doctor", description: "检查 Claude Code 安装状态", builtin: true, terminalOnly: true },
  { name: "/help", description: "显示帮助", builtin: true, terminalOnly: true },
  { name: "/init", description: "生成 CLAUDE.md 项目说明", builtin: true, terminalOnly: true },
  { name: "/login", description: "登录 Anthropic 账号", builtin: true, terminalOnly: true },
  { name: "/logout", description: "退出登录", builtin: true, terminalOnly: true },
  { name: "/memory", description: "编辑记忆文件", builtin: true, terminalOnly: true },
  { name: "/model", description: "选择模型", builtin: true, terminalOnly: true },
  { name: "/mcp", description: "MCP 服务器管理", builtin: true, terminalOnly: true },
  { name: "/permissions", description: "查看/修改工具权限", builtin: true, terminalOnly: true },
  { name: "/resume", description: "恢复历史会话", builtin: true, terminalOnly: true },
  { name: "/status", description: "显示会话状态", builtin: true, terminalOnly: true },
  { name: "/usage", description: "显示用量限额", builtin: true, terminalOnly: true },
  { name: "/agents", description: "管理自定义子代理", builtin: true, terminalOnly: true },
  { name: "/hooks", description: "管理 hooks", builtin: true, terminalOnly: true },
  { name: "/todos", description: "显示任务清单", builtin: true, terminalOnly: true },
  { name: "/review", description: "代码审查", builtin: true, terminalOnly: true },
  { name: "/bug", description: "报告问题", builtin: true, terminalOnly: true },
  { name: "/exit", description: "退出 Claude Code", builtin: true, terminalOnly: true },
];

/** 可注入的最小 fs 子集（测试 fake） */
export interface CommandFsLike {
  readdir(dir: string): Promise<import("node:fs").Dirent[]>;
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const defaultFs: CommandFsLike = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
  stat,
};

/** frontmatter description 或正文首行 → 描述文本（截断 DESCRIPTION_LIMIT） */
export function extractDescription(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") break;
      const m = line.match(/^description:\s*(.+)$/i);
      if (m) return clampDescription(m[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t === "---") continue;
    if (/^[A-Za-z_-]+:\s*/.test(t)) continue; // frontmatter 外的 key: value 元数据行
    return clampDescription(t.replace(/^#+\s*/, "").replace(/^[-*]\s+/, ""));
  }
  return "";
}

function clampDescription(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= DESCRIPTION_LIMIT ? t : `${t.slice(0, DESCRIPTION_LIMIT)}…`;
}

/** 命令名合法性：字母数字开头，允许 `-_ :`；拒绝空白/引号/斜杠（防注入响应） */
const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * 扫描 ~/.claude/commands/ 下的 .md 命令文件 → 自定义命令（builtin=false, terminalOnly=false）。
 * 命名：根下 `name.md` → `/name`；子目录 `dir/name.md` → `/dir:name`（Claude Code 命名空间约定）。
 */
export async function scanClaudeCustomCommands(
  commandsDir: string,
  fsLike: CommandFsLike = defaultFs,
): Promise<CommandDto[]> {
  const out: CommandDto[] = [];
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fsLike.readdir(commandsDir);
  } catch {
    return []; // 目录不存在/无权限：降级空列表
  }
  const files: Array<{ name: string; path: string }> = [];
  for (const entry of dirEntries) {
    if (out.length + files.length >= MAX_COMMANDS) break;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push({ name: entry.name.slice(0, -3), path: join(commandsDir, entry.name) });
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      let sub: import("node:fs").Dirent[];
      try {
        sub = await fsLike.readdir(join(commandsDir, entry.name));
      } catch {
        continue;
      }
      for (const s of sub) {
        if (out.length + files.length >= MAX_COMMANDS) break;
        if (s.isFile() && s.name.endsWith(".md")) {
          files.push({ name: `${entry.name}:${s.name.slice(0, -3)}`, path: join(commandsDir, entry.name, s.name) });
        }
      }
    }
  }
  for (const file of files) {
    if (out.length >= MAX_COMMANDS) break;
    if (!COMMAND_NAME_RE.test(file.name)) continue;
    let content = "";
    try {
      content = (await fsLike.readFile(file.path)).slice(0, COMMAND_FILE_LIMIT);
    } catch {
      continue; // 读不了就跳过，不影响其余命令
    }
    out.push({
      name: `/${file.name}`,
      description: extractDescription(content),
      builtin: false,
      terminalOnly: false,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface CommandsApi {
  list(source: SessionSource, commandsDir?: string): Promise<CommandListDto>;
}

/** 默认 ~/.claude/commands */
export function defaultClaudeCommandsDir(): string {
  return join(homedir(), ".claude", "commands");
}

export function createCommandsApi(fsLike: CommandFsLike = defaultFs, claudeDir = defaultClaudeCommandsDir()): CommandsApi {
  return {
    async list(source: SessionSource, commandsDir?: string): Promise<CommandListDto> {
      if (source === "pi") {
        return { source, commands: [...PI_BUILTIN_COMMANDS] };
      }
      const custom = await scanClaudeCustomCommands(commandsDir ?? claudeDir, fsLike);
      return { source, commands: [...CLAUDE_BUILTIN_COMMANDS, ...custom] };
    },
  };
}
