/** 协议形状的纯函数：审批结果绝不采用手机回传的权限配置。 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import type { EffectivePolicyDto, HostUserQuestion } from "../types.js";
import { isUnderRoot, uploadRootsFor } from "../uploads.js";
import { isRecord } from "./codex-rpc.js";

export type CodexDriverMode = "prompt" | "steer" | "followUp";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalType = "commandExecution" | "fileChange" | "permissions";
export interface CodexApprovalItemPreview { command?: string; fileChangeDetail?: string }
export type CodexUserInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };
export const APPROVAL_PREVIEW_MAX_BYTES = 8 * 1024;
const PREVIEW_TRUNCATED = "\n…（预览已截断，完整改动请在电脑端查看）";
const NO_FILE_DIFF = "尚未收到该项的文件 diff；请先在电脑端核对实际改动。";
const SENSITIVE_FILE_HIDDEN = "敏感文件（凭据/密钥类）：不在手机上展示内容，请在电脑端核对实际改动。";

/**
 * 私钥整块（RSA/EC/OPENSSH/ENCRYPTED 等标签）：未闭合也整段吃掉。
 * 审批卡会把命令全文与文件 diff（≤ 8KB）明文推到手机，只靠令牌前缀匹配拦不住密钥文件。
 */
const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/**
 * 已知平台令牌形状（P2-5）：GitHub（ghp_/gho_/ghu_/ghs_/ghr_/github_pat_）、AWS（AKIA/ASIA）、
 * Slack（xox[baprs]-）、Tailscale（tp-）、TrueLayer（tvly-）、Anthropic/OpenAI（sk-ant-/sk-proj-/sk-）。
 * 长前缀先列（正则候选左→右），保证 sk-ant-… 不被通用 sk- 提前截短。
 */
const KNOWN_TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|tp-[A-Za-z0-9_-]{16,}|tvly-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{12,})/g;
/** 赋值形式的敏感变量（.env / shell 导出 / 查询串）：键名以凭据语义结尾即脱敏值 */
const SECRET_ASSIGNMENT = /((?:[A-Za-z0-9_]*(?:API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS|PRIVATE_KEY))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
/** 敏感文件名（basename 口径）：命中只给路径不给 diff 内容 */
const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env / .env.local / .env.production
  /^id_[a-z0-9]+$/i, // id_rsa / id_ed25519（ssh 私钥；*.pub 例外）
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^credentials(\..+)?$/i, // credentials / credentials.json（~/.aws/credentials）
  /^auth\.json$/i, // ~/.codex/auth.json（硬规则 1：绝不回显）
  /^\.(netrc|npmrc|pgpass|pypirc|git-credentials)$/i,
  /(^|[^a-z0-9])(secret|credential|passw(or)?d|private[_-]?key)s?([^a-z0-9]|$)/i,
  /token.*\.json$/i, // gcloud token.json 类
];
/** 敏感文件在 diff 路径行里的子串口径（比 basename 宽松，仅用于路径行） */
const SENSITIVE_PATH_HINTS: readonly RegExp[] = [
  /\.env(?:[.\-/\\\s"']|$)/i,
  /id_[a-z0-9]+(?:\s|$|["'])/i,
  /\.(pem|key|p12|pfx|jks|keystore)(?:\s|$|["'])/i,
  /auth\.json/i,
  /credentials/i,
  /\.(netrc|npmrc|pgpass|git-credentials)(?:\s|$|["'])/i,
];
/** diff 里只有这几类行是文件路径（不扫正文，避免误伤提到 .env 的普通代码 diff） */
const DIFF_PATH_LINE = /^(?:diff --git|---|\+\+\+|Index:|rename (?:from|to)|copy (?:from|to))\b/;

export const APPROVAL_METHODS: Readonly<Record<string, CodexApprovalType>> = Object.freeze({
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
});

/** 服务请求的手机交互通道：审批三类 / requestUserInput 问答 / MCP elicitation（其余不下发手机） */
export type HostRequestKind = "approval" | "userInput" | "elicitation";

/** 分流 server request；返回 null = 不提供手机交互（token 刷新/attestation/未知方法，安全红线保持现状） */
export function serverRequestKind(method: string): HostRequestKind | null {
  if (Object.hasOwn(APPROVAL_METHODS, method)) return "approval";
  if (method === "item/tool/requestUserInput") return "userInput";
  if (method === "mcpServer/elicitation/request") return "elicitation";
  return null;
}

/* ===== 交互式问答（item/tool/requestUserInput + mcpServer/elicitation/request）===== */

/** 卡片题目上限：超过无法在手机上安全展示（拒绝建卡，绝不悄悄丢题造成“部分回答”歧义） */
export const QUESTION_MAX = 20;
/** 每题文本字段（question/header/label/description）上限：脱敏后截断到 4KB */
export const QUESTION_TEXT_MAX_BYTES = 4 * 1024;
/** 应答形状上限：每题元素数与单元素长度（与题面文本同口径） */
export const ANSWER_MAX_PER_QUESTION = 20;
/** 交互式提问未获用户回答：协议规定用 -32800（requestUserInput 专用），绝不代答 */
export const USER_INPUT_UNANSWERED_CODE = -32800;
const USER_INPUT_UNANSWERED_MESSAGE = "user input timed out/cancelled without an answer";
const USER_INPUT_DECLINED_MESSAGE = "user declined to answer";

/** 脱敏 + 截断题面文本；空/非字符串一律 null（容错缺失字段） */
function questionText(value: unknown, limit = QUESTION_TEXT_MAX_BYTES): string | null {
  return typeof value === "string" && value.trim() !== "" ? safePreview(value, limit) : null;
}

function questionOptions(value: unknown): HostUserQuestion["options"] {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: NonNullable<HostUserQuestion["options"]> = [];
  for (const item of value.slice(0, ANSWER_MAX_PER_QUESTION)) {
    if (!isRecord(item)) continue;
    const label = questionText(item.label);
    if (label === null) continue;
    options.push({ label, description: questionText(item.description) });
  }
  return options.length > 0 ? options : null;
}

/**
 * `item/tool/requestUserInput` → 问答卡片题目。无法安全映射（缺 questions/超上限/重复 id）
 * 返回 null，调用方安全拒绝（不挂起）；绝不返回残缺题目让用户在手机上误答。
 */
export function parseUserInputQuestions(params: Record<string, unknown>): HostUserQuestion[] | null {
  const raw = params.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > QUESTION_MAX) return null;
  const questions: HostUserQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return null;
    // id 是应答映射键，必须原样保留（不脱敏不截断），重复/超长会让映射歧义 → 整体拒绝
    const id = typeof item.id === "string" && item.id.trim() !== "" && Buffer.byteLength(item.id) <= 512 ? item.id : null;
    if (id === null || seen.has(id)) return null;
    seen.add(id);
    const header = questionText(item.header);
    const question = questionText(item.question) ?? header ?? id;
    questions.push({ id, header, question, options: questionOptions(item.options) });
  }
  return questions;
}

/** elicitation 属性类型（accept 时按它归一 content 值；integer 归为 number） */
export type ElicitationValueType = "string" | "number" | "boolean";

/**
 * `mcpServer/elicitation/request` → 问答卡片（每个 schema 属性一题，id=属性名，enum 转 options，
 * description 转问题文本）。schema 形状无法安全映射（嵌套 object/array、缺 properties、
 * 超上限等）返回 null，调用方保持现状 decline（安全取消，不算挂起）。
 */
export function parseElicitationQuestions(params: Record<string, unknown>): { questions: HostUserQuestion[]; types: Record<string, ElicitationValueType> } | null {
  const message = questionText(params.message, 1_000);
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return null;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > QUESTION_MAX) return null;
  const questions: HostUserQuestion[] = [];
  const types: Record<string, ElicitationValueType> = {};
  for (const [name, spec] of entries) {
    if (name.trim() === "" || Buffer.byteLength(name) > 512 || !isRecord(spec)) return null;
    const rawEnum = spec.enum;
    const enumValues = Array.isArray(rawEnum) && rawEnum.length > 0 && rawEnum.length <= ANSWER_MAX_PER_QUESTION
      ? rawEnum.filter((value): value is string => typeof value === "string" && value.trim() !== "") : null;
    // 给了 enum 就必须能完整映射为选项（空/非字符串/超限 → 整体拒绝，绝不丢选项）
    if (rawEnum !== undefined && (enumValues === null || enumValues.length === 0)) return null;
    const type: ElicitationValueType | null = spec.type === "string" || (spec.type === undefined && enumValues) ? "string"
      : spec.type === "number" || spec.type === "integer" ? "number"
      : spec.type === "boolean" ? "boolean" : null;
    if (type === null) return null; // 嵌套 object/array 或未知类型 → 无法在卡片上安全映射
    types[name] = type;
    questions.push({
      id: name,
      header: message,
      question: questionText(spec.description) ?? message ?? name,
      options: enumValues ? enumValues.map((value) => ({ label: questionText(value) ?? value, description: null })) : null,
    });
  }
  return { questions, types };
}

/**
 * 校验手机回传的 answers（不消费请求）：未知 key / 空数组 / 超限 / 非字符串一律 400。
 * 允许部分回答（不要求全答），但每题若给出则必须非空。
 */
export function validateQuestionAnswers(questions: readonly HostUserQuestion[], answers: unknown): asserts answers is Record<string, string[]> {
  if (!isRecord(answers) || Array.isArray(answers)) throw new HubError(ErrorCodes.INVALID_REQUEST, "answers 必须是 { [questionId]: string[] }");
  const keys = Object.keys(answers);
  if (keys.length === 0 || keys.length > QUESTION_MAX) throw new HubError(ErrorCodes.INVALID_REQUEST, "answers 至少回答一题且不超过 20 题");
  const known = new Set(questions.map((question) => question.id));
  for (const [key, value] of Object.entries(answers)) {
    if (!known.has(key)) throw new HubError(ErrorCodes.INVALID_REQUEST, `未知 questionId: ${safePreview(key, 80)}`);
    if (!Array.isArray(value) || value.length === 0 || value.length > ANSWER_MAX_PER_QUESTION) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, `answers.${key} 必须是非空字符串数组（不超过 ${ANSWER_MAX_PER_QUESTION} 项）`);
    }
    for (const element of value) {
      if (typeof element !== "string" || element.trim() === "" || Buffer.byteLength(element) > QUESTION_TEXT_MAX_BYTES) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, `answers.${key} 的每项必须是不超过 4KB 的非空字符串`);
      }
    }
  }
}

/** requestUserInput 应答：双层嵌套 `{ answers: { qid: { answers: [...] } } }`，绝不写成 answers 数组 */
export function buildUserInputResult(answers: Record<string, string[]>): Record<string, unknown> {
  const nested: Record<string, { answers: string[] }> = {};
  for (const [key, value] of Object.entries(answers)) nested[key] = { answers: [...value] };
  return { answers: nested };
}

/** 问答卡片的标题/摘要：与审批卡同口径，只展示已脱敏的题面 */
export function questionCardPreview(kind: "userInput" | "elicitation", questions: readonly HostUserQuestion[]): { title: string; detail: string | null; toolName: string } {
  const title = questions[0]?.header ?? (kind === "elicitation" ? "MCP 工具需要补充信息" : "工具向你提问");
  const detail = questions.map((question) => `${question.header ? `${question.header}：` : ""}${question.question}`).join("\n");
  return {
    title: safePreview(title, 120),
    detail: detail === "" ? null : safePreview(detail, QUESTION_TEXT_MAX_BYTES),
    toolName: kind === "elicitation" ? "elicitation" : "requestUserInput",
  };
}

/** elicitation accept：值按 schema type 基本归一（string/number/boolean），每题取首个回答 */
export function buildElicitationAccept(types: Record<string, ElicitationValueType>, answers: Record<string, string[]>): Record<string, unknown> {
  const content: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(answers)) {
    const raw = value[0];
    const type = types[key] ?? "string";
    if (type === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new HubError(ErrorCodes.INVALID_REQUEST, `answers.${key} 必须是数字`);
      content[key] = parsed;
    } else if (type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new HubError(ErrorCodes.INVALID_REQUEST, `answers.${key} 必须是 true|false`);
      content[key] = raw === "true";
    } else content[key] = raw;
  }
  return { action: "accept", content };
}

/** rpc 应答的两种通道：正常 result 或协议错误（问答未作答时用 -32800，绝不代答） */
export type CodexRpcReply = { result: Record<string, unknown> } | { rpcError: { code: number; message: string } };

/**
 * 未获用户回答的 rpc 应答（TTL 超时/turn 失效/清理）：问答用 -32800 错误、elicitation
 * 保持现有 decline（安全取消）、审批 cancel/decline。硬规则：绝不代用户选任何选项。
 * cancelled=true（取消/turn 失效）时审批回 cancel；TTL 超时传 false 回 decline（与既有语义一致）。
 */
export function unansweredRpcReply(kind: "approval" | "userInput" | "elicitation", type: CodexApprovalType | null, permissions: Record<string, unknown> = {}, cancelled = true): CodexRpcReply {
  if (kind === "userInput") return { rpcError: { code: USER_INPUT_UNANSWERED_CODE, message: USER_INPUT_UNANSWERED_MESSAGE } };
  if (kind === "elicitation") return { result: { action: "decline", content: null } };
  return { result: buildApprovalResult(type ?? "permissions", "deny", permissions, cancelled) };
}

/** 用户明确拒绝：问答同样回 -32800（不冒充用户回答）；elicitation 回 decline */
export function declinedRpcReply(kind: "approval" | "userInput" | "elicitation", type: CodexApprovalType | null, permissions: Record<string, unknown> = {}): CodexRpcReply {
  if (kind === "userInput") return { rpcError: { code: USER_INPUT_UNANSWERED_CODE, message: USER_INPUT_DECLINED_MESSAGE } };
  if (kind === "elicitation") return { result: { action: "decline", content: null } };
  return { result: buildApprovalResult(type ?? "permissions", "deny", permissions) };
}

/** 进程参数不覆盖审批策略或沙箱设置。 */
export function buildDriverArgs(): string[] { return ["app-server"]; }

export function buildResumeParams(threadId: string, options: { cwd?: string; approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandbox } = {}): Record<string, unknown> {
  return {
    threadId,
    excludeTurns: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  };
}

export function parseDriverMode(value: unknown): CodexDriverMode {
  if (value === undefined || value === null) return "prompt";
  if (value === "prompt" || value === "steer" || value === "followUp") return value;
  throw new HubError(ErrorCodes.INVALID_REQUEST, "mode 必须为 prompt|steer|followUp");
}

/** 审批与沙箱是独立维度；只有 approval=never 明确不请求审批。 */
export function isBypassPolicy(approval: string, _sandbox: string): boolean {
  return approval === "never";
}

/**
 * 从 `thread/resume`（或 `thread/start`）响应解析**实际生效**的策略；两个维度都取不到
 * → null（调用方不下发该字段，前端按「未知」容错）。
 * 数据只来自协议回显，绝不读 ~/.codex/config.toml（硬规则 1：不碰凭据相关配置）。
 * 形状容错：字段可在顶层或 thread 内；sandbox 可是字符串或 `{ type: "dangerFullAccess" }`。
 */
export function parseEffectivePolicy(result: unknown): EffectivePolicyDto | null {
  if (!isRecord(result)) return null;
  const thread = isRecord(result.thread) ? result.thread : null;
  const pick = (key: string): unknown => (thread !== null && thread[key] !== undefined ? thread[key] : result[key]);
  const rawApproval = pick("approvalPolicy");
  const approval = typeof rawApproval === "string" && rawApproval.trim() !== "" ? kebabCase(rawApproval.trim()) : null;
  const sandbox = normalizeSandboxEcho(pick("sandbox"));
  if (approval === null && sandbox === null) return null;
  const effectiveApproval = approval ?? "unknown";
  const effectiveSandbox = sandbox ?? "unknown";
  return { approval: effectiveApproval, sandbox: effectiveSandbox, bypass: isBypassPolicy(effectiveApproval, effectiveSandbox) };
}

/** camelCase → kebab-case（dangerFullAccess → danger-full-access） */
function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** sandbox 回显形状容错：字符串 / { type | mode | sandbox }，其余按未知 */
function normalizeSandboxEcho(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return kebabCase(value.trim());
  if (isRecord(value)) {
    for (const key of ["type", "mode", "sandbox"]) {
      const inner = value[key];
      if (typeof inner === "string" && inner.trim() !== "") return kebabCase(inner.trim());
    }
  }
  return null;
}

/**
 * 图片走原生 localImage 输入（不降为 @path 文本、不把 base64 塞进 RPC）；
 * 路径在本函数内自行校验（不信任调用方），只接受上传根内的真实文件。
 */
export function buildTurnInput(text: unknown, images: unknown, cwd: string): CodexUserInput[] {
  if (typeof text !== "string") throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是字符串");
  if (images !== undefined && (!Array.isArray(images) || images.length > 20)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "images 必须是图片路径数组（最多 20 张）");
  }
  const result: CodexUserInput[] = text.trim() === "" ? [] : [{ type: "text", text, text_elements: [] }];
  // P2-6：本函数是导出接口，`CodexDriverHub.send` 之外的新调用点可直达，只靠「路径已由
  // 上传路由校验」的注释信任调用方 = 传一个绝对路径就能让 codex 把任意本地文件当图片读走
  // （`{type:"localImage", path}`）。这里在内部再校验一次：复用上传根判定
  // （uploads.uploadRootsFor + isUnderRoot）并追加 realpath 双校验（与 uploads.isUnderRootReal
  // 同口径的同步版），只有真实路径落在上传根内才下发 localImage；其余降级为纯文本提示
  // （与 claude 侧「@path 文本降级」口径一致），绝不放宽成 cwd 内任意文件。
  const roots = uploadRootsFor(typeof cwd === "string" && cwd !== "" ? cwd : null).map((root) => resolve(root));
  const rejected: string[] = [];
  for (const image of (images ?? []) as unknown[]) {
    const path = typeof image === "string" ? image : isRecord(image) ? image.path : undefined;
    if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "图片缺少有效的本地路径");
    }
    const candidate = resolve(cwd || process.cwd(), path);
    if (!isUploadRooted(candidate, roots)) {
      rejected.push(safePreview(path, 120));
      continue;
    }
    result.push({ type: "localImage", path: candidate });
  }
  // 越界附件不静默丢：明确告知手机端图片没进上下文（路径经脱敏 + 截断）
  if (rejected.length > 0) {
    result.push({
      type: "text",
      text: `[已忽略 ${rejected.length} 个不在上传目录内的图片路径：${rejected.join("、")}（附件只能来自会话上传目录）]`,
      text_elements: [],
    });
  }
  if (result.length === 0) throw new HubError(ErrorCodes.INVALID_REQUEST, "text 或 images 至少提供一项");
  return result;
}

/** 严格包含判定（不含上传根自身）+ 符号链接逃逸二次校验（root 内 symlink 指向 root 外一律拒） */
function isUploadRooted(candidate: string, roots: readonly string[]): boolean {
  const abs = resolve(candidate);
  if (!roots.some((root) => isUnderRoot(root, abs) && abs !== resolve(root))) return false;
  return roots.some((root) => isUnderRootRealSync(root, abs));
}

/** isUnderRootReal 的同步版（send 路径是同步的）；根或文件不存在 → 保守拒绝（真附件必然已落盘） */
function isUnderRootRealSync(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const real = realpathSync(resolve(target));
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/** 保存原请求权限的独立快照，不使用手机回传的权限或授权范围。 */
export function snapshotRequestedPermissions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const field of ["fileSystem", "network"]) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) result[field] = JSON.parse(JSON.stringify(value[field]));
  }
  return result;
}

export function buildApprovalResult(
  type: CodexApprovalType,
  outcome: "allow" | "deny",
  originalPermissions: Record<string, unknown> = {},
  cancelled = false,
): Record<string, unknown> {
  if (type === "permissions") return {
    permissions: outcome === "allow" ? snapshotRequestedPermissions(originalPermissions) : {},
    scope: "turn",
  };
  return { decision: outcome === "allow" ? "accept" : cancelled ? "cancel" : "decline" };
}

/** 权限卡仅展示白名单中的可读摘要，不透传整个服务端请求。 */
export function hostRequestPreview(type: CodexApprovalType, params: Record<string, unknown>, item?: CodexApprovalItemPreview): { title: string; detail: string | null; toolName: string } {
  const reason = typeof params.reason === "string" ? safePreview(params.reason, 1_000) : "";
  if (type === "commandExecution") {
    const command = typeof params.command === "string" && params.command.trim() ? safePreview(params.command, 1_000) : item?.command ?? "";
    const cwd = typeof params.cwd === "string" ? safePreview(params.cwd, 300) : "";
    return {
      title: command ? `执行命令：${command.slice(0, 120)}` : "允许执行命令？",
      detail: [command, cwd ? `目录：${cwd}` : "", reason].filter(Boolean).join("\n") || null,
      toolName: "commandExecution",
    };
  }
  if (type === "fileChange") return {
    title: "允许修改文件？",
    detail: boundedApprovalDetail([reason, item?.fileChangeDetail ?? NO_FILE_DIFF].filter(Boolean).join("\n\n")),
    toolName: "fileChange",
  };
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const summary: string[] = [];
  if (isRecord(permissions.network) && permissions.network.enabled === true) summary.push("请求网络访问");
  if (isRecord(permissions.fileSystem)) {
    const fs = permissions.fileSystem;
    for (const field of ["read", "write"]) {
      if (Array.isArray(fs[field])) {
        const paths = (fs[field] as unknown[]).filter((path): path is string => typeof path === "string");
        if (paths.length) summary.push(`${field === "write" ? "写入" : "读取"}：${safePreview(paths.join(", "), 600)}`);
      }
    }
    if (Array.isArray(fs.entries)) {
      for (const entry of fs.entries.slice(0, 20)) {
        if (!isRecord(entry) || !isRecord(entry.path)) continue;
        const path = entry.path;
        const name = typeof path.path === "string" ? path.path : typeof path.pattern === "string" ? path.pattern : "系统路径";
        const access = entry.access === "write" ? "写入" : entry.access === "deny" ? "限制" : "读取";
        summary.push(`${access}：${safePreview(name, 200)}`);
      }
    }
  }
  return { title: "允许本轮新增权限？", detail: [reason, ...summary].filter(Boolean).join("\n") || "仅授予原请求中的权限，范围限当前轮", toolName: "permissions" };
}

/** 仅缓存已收到的同轮 item 白名单字段；绝不保存/序列化整个工具条目。 */
export function approvalItemPreview(item: Record<string, unknown>): CodexApprovalItemPreview | null {
  if (item.type === "commandExecution" && typeof item.command === "string") return { command: safePreview(item.command.slice(0, 1_001), 1_000) };
  if (item.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) return null;
  const parts: string[] = [];
  let clipped = false;
  for (const [index, value] of item.changes.entries()) {
    if (index >= 100) { clipped = true; break; }
    if (!isRecord(value)) continue;
    const rawPath = typeof value.path === "string" ? value.path : null;
    const path = rawPath ? safePreview(rawPath.slice(0, 513), 512) : "未知文件";
    const kind = isRecord(value.kind) ? value.kind : {};
    const action = kind.type === "add" ? "新增" : kind.type === "delete" ? "删除" : "修改";
    const move = typeof kind.move_path === "string" ? `\n移动至：${safePreview(kind.move_path.slice(0, 513), 512)}` : "";
    // P2-5：敏感文件（.env* / ssh 私钥 / *.pem / credentials / auth.json 等）只给路径不给内容：
    // diff 正文里的自定义键名凭据不匹配任何令牌形状，明文上手机 = 泄露。
    // diff 头部（diff --git / --- / +++）指向敏感文件时同样隐藏整个正文。
    const rawDiff = typeof value.diff === "string" ? value.diff : "";
    const sensitive = (rawPath !== null && isSensitivePath(rawPath)) || diffHeaderIsSensitive(rawDiff);
    const diff = sensitive
      ? SENSITIVE_FILE_HIDDEN
      : rawDiff ? safePreview(rawDiff.slice(0, APPROVAL_PREVIEW_MAX_BYTES + 1), APPROVAL_PREVIEW_MAX_BYTES + 1) : "尚无该文件的 diff";
    parts.push(`文件：${path}（${action}）${move}\n${diff}`);
    clipped ||= (rawDiff.length > APPROVAL_PREVIEW_MAX_BYTES) ||
      (typeof value.path === "string" && value.path.length > 512) || (typeof kind.move_path === "string" && kind.move_path.length > 512);
    if (Buffer.byteLength(parts.join("\n\n")) > APPROVAL_PREVIEW_MAX_BYTES) { clipped = true; break; }
  }
  if (parts.length === 0) return { fileChangeDetail: NO_FILE_DIFF };
  return { fileChangeDetail: boundedApprovalDetail(parts.join("\n\n"), clipped) };
}

function boundedApprovalDetail(value: string, clipped = false): string {
  if (!clipped && Buffer.byteLength(value) <= APPROVAL_PREVIEW_MAX_BYTES) return value;
  const budget = APPROVAL_PREVIEW_MAX_BYTES - Buffer.byteLength(PREVIEW_TRUNCATED);
  const prefix = Buffer.from(value).subarray(0, budget).toString("utf8").replace(/\uFFFD$/, "");
  return `${prefix}${PREVIEW_TRUNCATED}`;
}

/**
 * 敏感文件判定（P2-5）：按 basename 匹配，命中者审批卡只给路径不给 diff 内容。
 * 宁过严勿过宽（误伤只是叫用户去电脑端看），公钥（*.pub）例外可展示。
 */
export function isSensitivePath(path: string): boolean {
  const base = basenameOf(path);
  if (base === "") return false;
  if (/\.pub$/i.test(base)) return false;
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/** diff 头部（仅路径行）指向敏感文件时也隐藏正文；不扫正文，避免误伤提到 .env 的代码 diff */
function diffHeaderIsSensitive(diff: string): boolean {
  if (diff === "") return false;
  for (const line of diff.split("\n", 8)) {
    if (!DIFF_PATH_LINE.test(line)) continue;
    if (SENSITIVE_PATH_HINTS.some((pattern) => pattern.test(line))) return true;
  }
  return false;
}

function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}

/** 错误、命令参数和权限摘要中的常见凭据格式先脱敏再展示。 */
export function safePreview(value: string, limit = 1_000): string {
  return value
    // 私钥整块优先（未闭合也整段吃掉，防截断后残留正文）
    .replace(PEM_PRIVATE_KEY_BLOCK, "[redacted private key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(KNOWN_TOKEN_SHAPES, "[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .slice(0, limit);
}

export function codexMessageId(threadId: string, itemId: string): string { return `codex-${threadId}-${itemId}`; }
