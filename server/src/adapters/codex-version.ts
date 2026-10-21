/**
 * 新建 codex 会话所需的 session_meta 版本/供应商解析（buildCodexNewRollout 专用）。
 *
 * ── 为什么需要这个模块（2026 真机实测，codex 0.162）──────────────────────────
 * hub 合成的最小 rollout 若缺 `cli_version`/`model_provider`，codex 0.162 在
 * app-server `thread/resume` 与平行模式 `codex exec resume <id> --json` 两条路上
 * 都报 -32603 "rollout at <file> is empty"（文案误导：文件并不空，是元数据不全），
 * 手机端「新建 codex 会话」发不出第一条消息。逐字段剔除实验结论：
 * - 必需：`cli_version`（缺失 → -32603）、`model_provider`（缺失 → -32600
 *   "Model provider `` not found"）；`cli_version` 不做严格版本门（写 0.143.0 也能 resume）
 * - 非必需但建议照写（贴近真实产物，降低未来版本挑剔风险）：顶层 `ordinal`、
 *   `source`、`runtime_workspace_roots`、`git`、`history_mode`
 * - `creator_user_id`/`creator_account_id`/`context_window` 非必需，且**绝不能**
 *   为填它们去读 ~/.codex/auth.json（安全硬口径：不读取/不记录/不回显任何凭据）
 *
 * ── cli_version 取值链（fail-fast，绝不写死假版本号）────────────────────────
 * a. spawn `<codexBin> --version` 探测（复用 codex-driver 的 probeCodexCapabilities，
 *    与接管 attach 同一份实现：5s 超时 / 输出上限 4KB / 正则 \b(\d+)\.(\d+)\.(\d+)，
 *    不复制第三份）
 * b. 探测失败 → 回落采样已有 rollout 首行 session_meta 的 cli_version（取最高版本；
 *    有界读取：最多 maxFiles 个文件、每个只读首行前 maxBytes，从最新日期目录扫起）
 * c. 两者都拿不到 → 抛 HubError（宁可显式失败，也不写出一个 codex 读不懂的残缺
 *    文件污染会话列表）
 *
 * ── model_provider 取值（守口径：不读 ~/.codex/config.toml）─────────────────
 * 与 b 同一趟采样拿「最新一条已有会话的 payload.model_provider」，采样不到回落
 * "openai"；也可经 CodexAdapterOptions.modelProvider 显式注入（测试/特殊配置用）。
 */
import type { spawn } from "node:child_process";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCodes, HubError } from "../errors.js";
import { probeCodexCapabilities } from "./codex-driver.js";
import { isCodexRolloutFileName } from "./codex-rollout.js";
import { isRecord } from "./codex-rpc.js";

/** 与 probeCodexCapabilities / cli/lib/codex-runtime.js 同口径的版本形态 */
const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?/;

/** 采样默认预算：最多 32 个文件、每个只读首行前 64KB（有界读取，不全量扫） */
export const SAMPLE_MAX_FILES = 32;
export const SAMPLE_MAX_BYTES_PER_FILE = 64 * 1024;

/** 从任意文本提取版本号（"codex-cli 0.162.0-alpha.17.2" → "0.162.0-alpha.17.2"）；不可识别返回 null */
export function normalizeCodexVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(VERSION_RE);
  return match ? match[0] : null;
}

/** 只比较数字主干 major.minor.patch（预发行/构建标签不改变主干序）；任一侧不可解析返回 null */
export function compareCodexVersions(left: string, right: string): number | null {
  const a = normalizeCodexVersion(left)?.match(VERSION_RE);
  const b = normalizeCodexVersion(right)?.match(VERSION_RE);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * spawn `<codexBin> --version` 探测版本；任何失败（二进制缺失/超时/非零退出/输出
 * 无法识别）都返回 null 而不抛——调用方负责回落采样。探测实现在 codex-driver.ts
 * （probeCodexCapabilities，已导出），此处只是包一层「失败静默」语义，不复制逻辑。
 */
export async function probeCodexCliVersion(deps: {
  codexBin: string;
  spawnFn: typeof spawn;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  try {
    const capabilities = await probeCodexCapabilities({
      codexBin: deps.codexBin,
      cwd: "", // 版本探测与工作目录无关
      env: deps.env ?? process.env,
      // 永不主动 abort：probeCodexCapabilities 自带 5s 超时 + SIGKILL 收尾
      signal: new AbortController().signal,
      spawnFn: deps.spawnFn,
    });
    return capabilities.version;
  } catch {
    return null;
  }
}

/** rollout 首行 session_meta 采样结果 */
export interface CodexRolloutMetaSample {
  /** 采样范围内最高的 cli_version（无则 null） */
  cliVersion: string | null;
  /** 最新一条带 model_provider 的会话取值（扫描序新→旧，首个即最新；无则 null） */
  modelProvider: string | null;
  /** 实际读取的 rollout 文件数（诊断/测试断言用） */
  sampledFiles: number;
}

/** 目录下纯数字命名的子目录（YYYY/MM/DD 日期树的一级），名字倒序 = 日期新→旧 */
async function listNumericDirsDesc(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{1,4}$/.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return []; // 目录不存在/不可读：视为空
  }
}

/** 目录下的 rollout 文件，名字倒序（文件名含 ISO 时间戳，倒序 ≈ 新→旧） */
async function listRolloutFilesDesc(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isCodexRolloutFileName(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/**
 * 读单个 rollout 的首行（≤maxBytes，不整包加载）提取 session_meta 的
 * cli_version/model_provider；文件不可读/首行损坏/首行非 session_meta → null。
 */
async function readFirstLineMeta(
  file: string,
  maxBytes: number,
): Promise<{ cliVersion: string | null; modelProvider: string | null } | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    // Buffer.alloc 零填充：bytesRead 之后全是 0x00，永远不会误匹配 \n，无需限定搜索终点
    const lineEnd = buffer.indexOf(0x0a);
    const line = buffer.subarray(0, lineEnd < 0 ? bytesRead : lineEnd).toString("utf8").trim();
    if (line === "") return null;
    const row: unknown = JSON.parse(line);
    if (!isRecord(row) || row.type !== "session_meta" || !isRecord(row.payload)) return null;
    const provider = row.payload.model_provider;
    return {
      cliVersion: normalizeCodexVersion(row.payload.cli_version),
      modelProvider: typeof provider === "string" && provider.trim() !== "" ? provider.trim() : null,
    };
  } catch {
    return null; // 采样是尽力而为：单文件失败不打断整体
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * 采样已有 rollout 首行的 session_meta：
 * - sessionsDir 按 YYYY/MM/DD 日期树从最新往旧扫；archivedDir（平铺）随后
 * - 最多读 maxFiles 个文件（默认 32），每个只读首行前 maxBytesPerFile 字节
 * - cli_version 取最高版本（防旧文件里混着降级前的更高版本）；
 *   model_provider 取最新一条非空值（最贴近用户当前配置）
 */
export async function sampleCodexRolloutMeta(
  sessionsDir: string,
  options: { archivedDir?: string; maxFiles?: number; maxBytesPerFile?: number } = {},
): Promise<CodexRolloutMetaSample> {
  const maxFiles = options.maxFiles ?? SAMPLE_MAX_FILES;
  const maxBytes = options.maxBytesPerFile ?? SAMPLE_MAX_BYTES_PER_FILE;
  const sample: CodexRolloutMetaSample = { cliVersion: null, modelProvider: null, sampledFiles: 0 };
  const files: string[] = [];
  for (const year of await listNumericDirsDesc(sessionsDir)) {
    for (const month of await listNumericDirsDesc(year)) {
      for (const day of await listNumericDirsDesc(month)) {
        files.push(...(await listRolloutFilesDesc(day)));
      }
    }
  }
  if (options.archivedDir) files.push(...(await listRolloutFilesDesc(options.archivedDir)));
  for (const file of files) {
    if (sample.sampledFiles >= maxFiles) break; // 有界预算：够判定即止，绝不全量扫
    sample.sampledFiles += 1;
    const meta = await readFirstLineMeta(file, maxBytes);
    if (meta === null) continue;
    if (meta.cliVersion !== null && (sample.cliVersion === null || (compareCodexVersions(meta.cliVersion, sample.cliVersion) ?? 0) > 0)) {
      sample.cliVersion = meta.cliVersion;
    }
    if (sample.modelProvider === null && meta.modelProvider !== null) sample.modelProvider = meta.modelProvider;
  }
  return sample;
}

/** 新建会话 session_meta 所需的运行时元数据 */
export interface CodexNewSessionMeta {
  cliVersion: string;
  modelProvider: string;
}

export interface CodexMetaResolutionDeps {
  codexBin: string;
  sessionsDir: string;
  archivedSessionsDir?: string;
  spawnFn: typeof spawn;
  /** 注入的 model_provider 优先（测试/显式配置）；缺省走采样 + "openai" 回落 */
  modelProvider?: string;
  env?: NodeJS.ProcessEnv;
  /** 采样预算注入（测试用小值） */
  sampleOptions?: { maxFiles?: number; maxBytesPerFile?: number };
}

/**
 * 解析新建会话 meta：探测 `--version` → 采样回落 → 都失败抛 HubError（fail-fast，
 * 宁可不建会话，也不落盘一个 codex 读不懂的残缺 rollout）。
 */
export async function resolveCodexNewSessionMeta(deps: CodexMetaResolutionDeps): Promise<CodexNewSessionMeta> {
  const injected = typeof deps.modelProvider === "string" && deps.modelProvider.trim() !== "" ? deps.modelProvider.trim() : null;
  const sample = (): Promise<CodexRolloutMetaSample> =>
    sampleCodexRolloutMeta(deps.sessionsDir, {
      archivedDir: deps.archivedSessionsDir,
      maxFiles: deps.sampleOptions?.maxFiles,
      maxBytesPerFile: deps.sampleOptions?.maxBytesPerFile,
    });
  // 未注入 provider 时无论探测成败都要采样（model_provider 只能来自已有会话）→ 并行省一趟延迟；
  // 已注入时先探测，只有探测失败才采样（为版本回落），不做无谓读盘。
  const probePromise = probeCodexCliVersion(deps);
  const samplePromise = injected === null ? sample() : null;
  const probed = await probePromise;
  let sampled = samplePromise !== null ? await samplePromise : null;
  if (probed === null && sampled === null) sampled = await sample();
  const cliVersion = probed ?? sampled?.cliVersion ?? null;
  if (cliVersion === null) {
    throw new HubError(
      ErrorCodes.INTERNAL,
      "无法探测 codex 版本（codex --version 执行失败，且已有会话中也采样不到 cli_version），暂不能新建 Codex 会话；请检查服务器的 codexBin 配置，或先在电脑端运行一次 codex 后重试",
      503,
    );
  }
  return { cliVersion, modelProvider: injected ?? sampled?.modelProvider ?? "openai" };
}
