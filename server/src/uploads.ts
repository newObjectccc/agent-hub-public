/**
 * 上传文件（POST /api/uploads）与 prompt 图片附件的服务器端实现。
 *
 * ── 调研结论（pi 多模态通道选择，2026-09-29 实测 @earendil-works/pi-coding-agent 0.87.1）──
 * - **通道 b（直接附图）**：`AgentSession.prompt(text, options)` 的 `PromptOptions.images?: ImageContent[]`
 *   （dist/core/agent-session.d.ts），`steer(text, images?)` / `followUp(text, images?)` 同样支持；
 *   `UserMessage.content = string | (TextContent | ImageContent)[]`（docs/message-types.md）。
 *   → pi 会话把上传图片以 ImageContent 直接进模型上下文。
 * - **通道 a（路径引用）**：SDK `prompt()` 不做 `@path` 展开（docs/cli.md 的 `@files` 是 CLI 参数层；
 *   docs/rpc.md 明确 RPC 模式拒绝 @file 参数，prompt 命令只收文本）。`@rel/path` 作为普通文本进模型，
 *   agent 用 read 工具读取（docs/cli.md：`read` = "Read text files and supported images"，支持图片）。
 * - **claude 侧**：`claude -p <text>` 只有文本通道，`@rel/path` 引用由 claude 的 Read 工具读取（同通道 a）。
 * → 双通道 a+b：pi 走 ImageContent + 文本引用；claude 走文本引用。本模块负责上传落盘与附件装载。
 *
 * ── 安全（硬规则）───────────────────────────────────────────────────────────
 * 1. 文件名清洗防穿越：去路径分隔符 / 控制字符 / `..`，最终落盘路径必须仍在上传目录内（双重校验）。
 * 2. 大小上限 10MB（base64 与解码后双向校验）、类型白名单（MIME + 扩展名兜底）。
 * 3. 上传目录固定 `.agent-hub-uploads/`（cwd 不可用时退临时目录），不进 git（仓库 .gitignore）。
 * 4. prompt 附件只能来自上传目录（cwd 内或临时上传根），拒绝 `../` 逃逸。
 * 5. 符号链接逃逸二次校验：resolve 级判定后追加 fs.realpath 校验，目标真实路径必须
 *    仍在允许根内（root 内 symlink 指向 root 外一律拒绝）。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { ErrorCodes, HubError } from "./errors.js";
import type { PromptImageAttachment, UploadDto } from "./types.js";

/** 会话 cwd 下的上传目录名（不进 git） */
export const UPLOAD_DIR_NAME = ".agent-hub-uploads";
/** 单文件大小上限 10MB */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 单条消息最多附带的图片数 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** HTTP body 上限（base64 膨胀 ~4/3 + JSON 包裹） */
export const MAX_UPLOAD_BODY_BYTES = 14 * 1024 * 1024;
/** 清洗后文件名最大长度（含扩展名） */
export const MAX_UPLOAD_NAME_LENGTH = 100;

/** MIME → 规范扩展名（类型白名单；image/* 同时允许作为 prompt 图片附件） */
export const ALLOWED_UPLOAD_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  /** 浏览器对未知类型常报 octet-stream：由扩展名白名单兜底 */
  "application/octet-stream": "",
};

/** 扩展名兜底白名单（MIME 缺失或 octet-stream 时按扩展名判定；扩展名 → 规范 MIME） */
export const FALLBACK_UPLOAD_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  // 常见代码/配置文本（agent 分析用，全部按纯文本处理）
  ts: "text/plain",
  js: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  sh: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  toml: "text/plain",
  css: "text/plain",
};

/** 是否图片 MIME（prompt 附件只收图片） */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** 取文件扩展名（小写、不含点；无扩展名返回 ""） */
export function fileExtension(name: string): string {
  const ext = extname(name).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/**
 * 文件名清洗（防路径穿越）：只留最后一段、去控制字符/非法字符/`..`、
 * 防伪装隐藏文件、限长（保扩展名）。任何输入都返回安全的纯文件名。
 */
export function sanitizeUploadName(raw: unknown): string {
  const asString = typeof raw === "string" ? raw : "";
  const last = asString.replace(/\\/g, "/").split("/").pop() ?? "";
  let name = last
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 防穿越：压掉所有 `..` 段（清洗后不可能再含路径分隔符或 `..`）
  name = name.replace(/\.{2,}/g, ".");
  // 去结尾点/空格（Windows 兼容）
  name = name.replace(/[.\s]+$/g, "");
  if (name === "") return "upload.bin";
  // 防伪装隐藏文件（.env 等）→ 前缀 upload
  if (name.startsWith(".")) name = `upload${name}`;
  return truncateName(name, MAX_UPLOAD_NAME_LENGTH);
}

/** 限长（保扩展名 ≤ 16 字符） */
export function truncateName(name: string, max = MAX_UPLOAD_NAME_LENGTH): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : "";
  const base = ext === "" ? name : name.slice(0, dot);
  return `${base.slice(0, Math.max(1, max - ext.length))}${ext}`;
}

/** 解析上传类型：MIME 白名单优先，octet-stream/缺失走扩展名兜底；非法抛 415 */
export function resolveUploadType(
  name: string,
  mimeRaw: unknown,
): { name: string; mimeType: string; extension: string } {
  const mime = typeof mimeRaw === "string" ? mimeRaw.split(";")[0].trim().toLowerCase() : "";
  const ext = fileExtension(name);
  const canonical = ALLOWED_UPLOAD_MIME[mime];
  if (canonical !== undefined && canonical !== "") {
    // MIME 在白名单：扩展名以 MIME 规范值为准（防 .exe 名字包图片等伪装）
    const stem = ext === "" ? name : name.slice(0, name.length - ext.length - 1);
    return { name: `${stem}.${canonical}`, mimeType: mime === "image/jpg" ? "image/jpeg" : mime, extension: canonical };
  }
  // octet-stream / 空 MIME：扩展名兜底
  const fallbackMime = FALLBACK_UPLOAD_EXT[ext];
  if (fallbackMime !== undefined) {
    return { name, mimeType: fallbackMime, extension: ext };
  }
  throw new HubError(
    ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
    `不支持的文件类型: ${mime === "" ? "(无 MIME)" : mime}${ext === "" ? "" : ` (.${ext})`}`,
    415,
  );
}

/** base64 严格校验（浏览器 FileReader 产出的标准 base64；允许尾部 padding） */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 解码 base64（校验失败 400，空文件 400，超限 413） */
export function decodeUploadData(data: unknown, maxBytes = MAX_UPLOAD_BYTES): Buffer {
  if (typeof data !== "string" || data === "") {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "data 必须是非空 base64 字符串");
  }
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "data 不是合法 base64");
  }
  // 解码前先按 base64 长度估算，避免为超大 payload 分配大 buffer
  const estimated = Math.floor((data.length * 3) / 4);
  if (estimated > maxBytes) {
    throw new HubError(ErrorCodes.UPLOAD_TOO_LARGE, `文件超过大小上限 ${maxBytes} 字节`, 413);
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "文件内容为空");
  }
  if (buffer.length > maxBytes) {
    throw new HubError(ErrorCodes.UPLOAD_TOO_LARGE, `文件超过大小上限 ${maxBytes} 字节`, 413);
  }
  return buffer;
}

/** sessionId 用作临时目录名时的清洗（只留安全字符，压平连续分隔符，无路径语义） */
export function sanitizeSessionId(sessionId: unknown): string {
  const raw = typeof sessionId === "string" ? sessionId : "";
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned === "" ? "misc" : cleaned;
}

/** 临时上传根目录（cwd 不可用时的兜底位置） */
export function tempUploadRoot(): string {
  return join(tmpdir(), "agent-hub-uploads");
}

export interface SaveUploadOptions {
  /** 会话 cwd（绝对路径）；null/无效 → 临时目录兜底 */
  cwd: string | null;
  sessionId?: string;
  name: unknown;
  mimeType: unknown;
  /** base64（不含 data: 前缀） */
  data: unknown;
  maxBytes?: number;
  /**
   * cwd 允许的根（workspaceRoot / 已知会话 cwd）；传入时 cwd 必须落在其一内，
   * 否则直接 400 拒绝（不静默退临时目录，防任意目录写入）。
   */
  allowedCwdRoots?: readonly string[];
}

/** 唯一文件名：冲突时 `name-1.ext`、`name-2.ext`… */
async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = fileExtension(name);
  const stem = ext === "" ? name : name.slice(0, name.length - ext.length - 1);
  const suffix = ext === "" ? "" : `.${ext}`;
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? name : `${stem}-${i}${suffix}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${randomBytes(4).toString("hex")}${suffix}`;
}

/** 目标路径必须落在目录内（防穿越双重校验） */
function assertContained(dir: string, target: string): void {
  const root = resolve(dir);
  const abs = resolve(target);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new HubError(ErrorCodes.INVALID_PATH, "上传路径越界", 400);
  }
}

/** target 是否落在 root 目录内（含 root 本身；resolve 级判定） */
export function isUnderRoot(root: string, target: string): boolean {
  const absRoot = resolve(root);
  const abs = resolve(target);
  return abs === absRoot || abs.startsWith(absRoot + sep);
}

/**
 * 符号链接逃逸二次校验（P2）：resolve 级判定不展开符号链接，root 内的 symlink 可指向
 * root 外。realpath 展开后目标真实路径必须仍在真实 root 内（root 自身的 symlink 也被展开
 * 后比较，合法的链接式目录布局不受影响）。目标/root 不存在 → 返回 false（由调用方保持
 * 原有 404/写入错误语义）。
 */
export async function isUnderRootReal(root: string, target: string): Promise<boolean> {
  try {
    const realRoot = await realpath(resolve(root));
    const real = await realpath(resolve(target));
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/**
 * 落盘上传文件：cwd 下 `.agent-hub-uploads/`，cwd 不可用退临时目录。
 * 返回可引用路径（cwd 内为相对路径，供 `@path` 引用；临时目录为绝对路径）。
 */
export async function saveUpload(options: SaveUploadOptions): Promise<UploadDto> {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const buffer = decodeUploadData(options.data, maxBytes);
  const safeName = sanitizeUploadName(options.name);
  const type = resolveUploadType(safeName, options.mimeType);

  const cwd = typeof options.cwd === "string" ? options.cwd : null;
  // cwd 白名单（workspaceRoot / 已知会话 cwd）：不在允许根内直接拒绝任意目录写入
  if (cwd !== null && options.allowedCwdRoots !== undefined) {
    const allowed = options.allowedCwdRoots.some(
      (root) => typeof root === "string" && root !== "" && isUnderRoot(root, cwd),
    );
    if (!allowed) {
      throw new HubError(ErrorCodes.INVALID_CWD, `cwd 不在允许的上传根内: ${cwd}`, 400);
    }
  }
  const cwdUsable = cwd !== null && isAbsolute(cwd) && existsSync(cwd);
  const dir = cwdUsable
    ? join(cwd, UPLOAD_DIR_NAME)
    : join(tempUploadRoot(), sanitizeSessionId(options.sessionId));
  await mkdir(dir, { recursive: true, mode: 0o755 });
  // 符号链接逃逸二次校验（P2）：上传目录本身可能是指向外部的 symlink，
  // realpath 展开后必须仍在允许根（cwd / 临时上传根）内
  const dirBase = cwdUsable ? cwd : tempUploadRoot();
  if (!(await isUnderRootReal(dirBase, dir))) {
    throw new HubError(ErrorCodes.INVALID_PATH, "上传路径越界（符号链接逃逸）", 400);
  }
  const storedName = await uniqueName(dir, type.name);
  const target = join(dir, storedName);
  assertContained(dir, target);
  await writeFile(target, buffer, { flag: "wx", mode: 0o644 });

  const absPath = resolve(target);
  const refPath = cwdUsable ? `${UPLOAD_DIR_NAME}/${storedName}` : absPath;
  return {
    name: storedName,
    path: refPath,
    absPath,
    mimeType: type.mimeType,
    size: buffer.length,
    isImage: isImageMime(type.mimeType),
  };
}

/** 附件引用允许的根（会话 cwd 上传目录 + 临时上传根） */
export function uploadRootsFor(cwd: string | null): string[] {
  const roots: string[] = [tempUploadRoot()];
  if (typeof cwd === "string" && cwd !== "" && isAbsolute(cwd)) {
    roots.unshift(resolve(cwd, UPLOAD_DIR_NAME));
  }
  return roots;
}

/**
 * 装载 prompt 图片附件（通道 b）：ref 相对 cwd 解析，必须落在上传目录内。
 * 非图片 / 越界 / 不存在 / 超限分别 415 / 400 / 404 / 413。
 */
export async function loadImageAttachments(
  cwd: string | null,
  refs: readonly unknown[],
): Promise<PromptImageAttachment[]> {
  if (!Array.isArray(refs)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "images 必须是数组");
  }
  if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`);
  }
  const roots = uploadRootsFor(cwd).map((root) => resolve(root));
  const out: PromptImageAttachment[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.trim() === "" || ref.includes("\u0000")) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "images 条目必须是非空路径字符串");
    }
    const candidate = isAbsolute(ref) ? resolve(ref) : resolve(cwd ?? "", ref);
    const ok = roots.some((root) => candidate.startsWith(root + sep));
    if (!ok) {
      throw new HubError(ErrorCodes.INVALID_PATH, `附件路径越界: ${ref}`, 400);
    }
    let size = 0;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      throw new HubError(ErrorCodes.FILE_NOT_FOUND, `附件不存在: ${ref}`, 404);
    }
    // 符号链接逃逸二次校验（P2）：root 内的 symlink 可指向 root 外，realpath 展开后再判
    const insideReal = await Promise.all(roots.map((root) => isUnderRootReal(root, candidate)));
    if (!insideReal.some(Boolean)) {
      throw new HubError(ErrorCodes.INVALID_PATH, `附件路径越界（符号链接逃逸）: ${ref}`, 400);
    }
    if (size > MAX_UPLOAD_BYTES) {
      throw new HubError(ErrorCodes.UPLOAD_TOO_LARGE, `附件超过大小上限 ${MAX_UPLOAD_BYTES} 字节`, 413);
    }
    const ext = fileExtension(candidate);
    const mime = FALLBACK_UPLOAD_EXT[ext];
    if (mime === undefined || !isImageMime(mime)) {
      throw new HubError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, `附件不是图片: ${ref}`, 415);
    }
    const buffer = await readFile(candidate);
    out.push({ path: ref, mimeType: mime, data: buffer.toString("base64") });
  }
  return out;
}

/**
 * claude 侧附件降级提示：文本未引用附件路径时补一行引用（通道 a：让 claude 用 Read 工具看图）。
 * 已含 `@path` / path 子串时原样返回，不重复添加。
 */
export function appendAttachmentHints(text: string, images: readonly PromptImageAttachment[] | undefined): string {
  if (!images || images.length === 0) return text;
  const missing = images.filter((img) => img.path !== "" && !text.includes(img.path));
  if (missing.length === 0) return text;
  const lines = missing.map((img) => `[附件图片] @${img.path}（请用 Read 工具查看）`);
  const base = text.trimEnd();
  return base === "" ? lines.join("\n") : `${base}\n\n${lines.join("\n")}`;
}
