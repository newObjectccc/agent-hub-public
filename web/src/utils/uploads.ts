/**
 * 上传/附件前端纯函数（契约 §11 客户端侧）。
 *
 * 与 server/src/uploads.ts 保持同一白名单口径（浏览器侧预检只为体验，
 * 真正的安全校验在 server）；引用语义：
 * - 插入输入框：`@<相对路径>`（pi/claude 都用 Read 工具读取，通道 a）
 * - 图片额外随 prompt 的 `images` 直接附图（pi ImageContent，通道 b，见 server/uploads.ts 调研）
 */

/** 单文件大小上限（与 server 一致：10MB） */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 单条消息最多附件数（与 server 一致） */
export const MAX_ATTACHMENTS = 8;

/** 附件草稿（上传成功 → 插入引用 + 缩略图预览条） */
export interface Attachment {
  id: string;
  /** 清洗后的文件名 */
  name: string;
  /** 可引用路径（相对会话 cwd 或绝对） */
  path: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  /** 图片预览 data URL（非图片为 null） */
  preview: string | null;
}

/** MIME 白名单（与 server ALLOWED_UPLOAD_MIME 同口径） */
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
  "application/octet-stream": "",
};

/** 扩展名兜底白名单（与 server FALLBACK_UPLOAD_EXT 同口径） */
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

/** 是否图片 MIME（缩略图预览 + prompt 直接附图的判定） */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** 文件名清洗（镜像 server sanitizeUploadName：去路径/控制字符/`..`，防穿越展示） */
export function sanitizeUploadName(raw: unknown): string {
  const asString = typeof raw === "string" ? raw : "";
  const last = asString.replace(/\\/g, "/").split("/").pop() ?? "";
  let name = last
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  name = name.replace(/\.{2,}/g, ".");
  name = name.replace(/[.\s]+$/g, "");
  if (name === "") return "upload.bin";
  if (name.startsWith(".")) name = `upload${name}`;
  return name.length <= 100 ? name : name.slice(0, 100);
}

/** 取扩展名（小写、不含点） */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 客户端预检：MIME/扩展名白名单（与 server 同口径，server 仍会二次校验） */
export function isAllowedUpload(mimeRaw: string, name: string): boolean {
  const mime = (mimeRaw ?? "").split(";")[0].trim().toLowerCase();
  const canonical = ALLOWED_UPLOAD_MIME[mime];
  if (canonical !== undefined && canonical !== "") return true;
  return FALLBACK_UPLOAD_EXT[fileExtension(name)] !== undefined;
}

/** 字节数人性化展示 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 引用 token（插入输入框的 `@path`） */
export function uploadRef(path: string): string {
  return `@${path.replace(/^@+/, "")}`;
}

/** 从文本中移除某个附件的引用（删除缩略图时同步清理输入框里的 `@path`） */
export function stripUploadRef(text: string, path: string): string {
  const token = uploadRef(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${token}(?=\\s|$)`, "g");
  return text
    .replace(re, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 发送文本兜底：正文为空但仍有附件时，用引用行作为消息（prompt 要求非空文本） */
export function buildSendText(text: string, attachments: readonly Attachment[]): string {
  const trimmed = text.trim();
  if (trimmed !== "") return trimmed;
  return attachments.map((a) => uploadRef(a.path)).join(" ");
}

/** 是否可发送（有正文或有附件，且不超上限） */
export function canSend(text: string, attachments: readonly Attachment[]): boolean {
  return (text.trim() !== "" || attachments.length > 0) && attachments.length <= MAX_ATTACHMENTS;
}

/** prompt `images` 参数（仅图片附件；server 转 pi ImageContent） */
export function imageRefs(attachments: readonly Attachment[]): string[] {
  return attachments.filter((a) => a.isImage).map((a) => a.path);
}

/**
 * File → data URL（jsdom/浏览器通用；超限/读失败 reject，调用方 toast）。
 * base64 段由 server 端最终解析，这里只做读取。
 */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("文件读取失败"));
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/** data URL → 纯 base64（server POST /api/uploads 的 data 字段） */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** 上传前的本地校验（大小/类型），返回错误文案或 null */
export function validateUploadFile(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return `${file.name}：文件为空`;
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name}：超过 10MB 上限（${formatBytes(file.size)}）`;
  if (!isAllowedUpload(file.type, file.name)) return `${file.name}：不支持的文件类型`;
  return null;
}
