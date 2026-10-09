/**
 * 会话文件实时观察（live tail）：
 * 非本进程启动的会话（终端里跑的 pi 等）没有 SDK 事件流，这里轮询 JSONL 文件、
 * diff 出新增消息后按契约推送 `message_end`（前端 reducer 同 id 覆盖、新 id 追加，零改动兼容），
 * 并推断运行态：文件持续写入 → status:"running"，静默 → status:"idle"。
 *
 * 解析成本（OOM 审计 AC1）：字节偏移增量解析——记录已解析偏移（停在完整行边界），
 * 每轮只读/只解析新增字节行，写到一半的半行留到下轮；活跃写入不再每轮全量读 + parse。
 * 增量能力由 MessageLoader 可选携带（pi session-format 自带 PiIncrementalParser；注入的
 * claude transcript loader 无该能力时安全回退全量解析，行为与旧实现一致）。
 * knownIds 去重始终兜底：任何路径下 message_end 都不丢不重不错序。
 *
 * 内存窗口化（OOM 审计 P2-2）：
 * - PiIncrementalParser.entries 只留最近窗口（条数 + 字节双上限），窗口外旧链不再驻留；
 *   需要全量语义时走文件重建（rewrite 重喂 / loadSessionMessages）。
 * - knownIds 换环形上限（FIFO 逐出）：丢弃窗口外 id 后靠「窗口内不重复」语义保正确——
 *   环容量 ≥ 解析器 entry 窗口 / 全量回退消息窗口（构造时强制鉗制），窗口内可产出的
 *   id 必然仍在环里，不会重推；窗口外的历史消息本来就不在增量产出里，也不会补推。
 */
import { open, stat } from "node:fs/promises";
import { buildMessages, loadSessionMessages, selectActiveBranch, type RawEntry } from "./scan.js";
import type { MessageDto, SessionStatus } from "../types.js";
import type { EmitFn } from "./hub.js";

/**
 * tail 推断出的运行态回写 sink（双状态源分叉修复）：tail 的 status 事件只走 WS 广播，
 * 不回写 hub/adapter 的内存状态源会让 WS 显示 running 而 API 返回 idle（或反之）。
 * hub.ts / claude.ts 构造时注册，把 tail 推断出的 status 回写进各自的 statuses。
 */
export type TailStatusSink = (sessionId: string, status: SessionStatus) => void;

const statusSinks = new Set<TailStatusSink>();

/** 注册 tail 状态回写 sink（返回注销函数） */
export function registerTailStatusSink(sink: TailStatusSink): () => void {
  statusSinks.add(sink);
  return () => statusSinks.delete(sink);
}

function notifyStatusSinks(sessionId: string, status: SessionStatus): void {
  for (const sink of statusSinks) {
    try {
      sink(sessionId, status);
    } catch {
      // 单个 sink 失败不影响广播与其它 sink
    }
  }
}

/** 增量解析器：只吃新增完整行，产出当前应有的消息序列（调用方 knownIds 去重后推送） */
export interface IncrementalParser {
  /** 喂入一行原始 JSONL 文本（不含换行符）；坏行/不识别行静默跳过 */
  pushLine(line: string): void;
  /** 当前累积状态下的消息列表（与全量解析同 id、同顺序） */
  messages(): MessageDto[];
}

/** 增量解析器窗口参数（P2-2）：条数 + 字节双上限，超出逐出最旧 entry */
export interface IncrementalParserOptions {
  /** entry 条数窗口（缺省 DEFAULT_ENTRY_WINDOW） */
  maxEntries?: number;
  /** entry 字节窗口（缺省 DEFAULT_ENTRY_WINDOW_BYTES，按原始行 UTF-8 字节数记账） */
  maxBytes?: number;
}

/** entry 条数窗口默认值（P2-2）：单轮写入 2000+ entry 并发不现实，正常会话永不融断 */
export const DEFAULT_ENTRY_WINDOW = 1_000;
/** entry 字节窗口默认值（P2-2）：10MB JSONL 不再全量驻留，只留最近 ≈2MB */
export const DEFAULT_ENTRY_WINDOW_BYTES = 2 * 1024 * 1024;
/** knownIds 环形上限默认值（P2-2）：8192 id ≈ 数百 KB，窗口内 id 必在环内 */
export const DEFAULT_KNOWN_IDS_MAX = 8_192;
/** 全量回退解析（claude/codex 无增量能力）只对账最近 N 条消息的窗口默认值 */
export const DEFAULT_MESSAGE_WINDOW = 4_096;

/** 消息加载器：按会话文件格式注入（pi session-format / claude transcript） */
export interface MessageLoader {
  (file: string): Promise<MessageDto[]>;
  /** 可选增量能力（pi 格式自带）；缺失时 tail 安全回退全量解析 */
  createIncremental?: (options?: IncrementalParserOptions) => IncrementalParser;
}

/**
 * pi session-format v3 增量解析器：按行解析 entry（与 scan.parseSessionJsonl 同规则），
 * 复用 selectActiveBranch + buildMessages 纯函数产出消息（与 loadSessionMessages 同口径）。
 * 只对新增行做 JSON.parse；历史 entries 窗口化驻留（P2-2）：只留最近 maxEntries 条/
 * maxBytes 字节，旧链出窗即弃（分支链路退化为尾链，只影响窗口内可产出消息，去重语义不变）。
 */
export class PiIncrementalParser implements IncrementalParser {
  private readonly entries: RawEntry[] = [];
  /** 与 entries 平行的原始行字节记账（窗口裁剪用，避免反复 JSON.stringify 重算） */
  private readonly entryBytes: number[] = [];
  private entriesBytes = 0;
  private headerSeen = false;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: IncrementalParserOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_ENTRY_WINDOW);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_ENTRY_WINDOW_BYTES);
  }

  pushLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // 坏行跳过，与 parseSessionJsonl 同口径
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const entry = parsed as RawEntry;
    if (typeof entry.type !== "string") return;
    if (entry.type === "session" && !this.headerSeen) {
      this.headerSeen = true;
      return; // 文件首个 session 行是 header，不进 entries（同 parseSessionJsonl）
    }
    this.entries.push(entry);
    const bytes = Buffer.byteLength(trimmed, "utf8");
    this.entryBytes.push(bytes);
    this.entriesBytes += bytes;
    this.trimWindow();
  }

  /** 窗口裁剪（P2-2）：条数/字节任一超限即逐出最旧（至少保 1 条，最新消息永不被裁） */
  private trimWindow(): void {
    while (this.entries.length > 1 && (this.entries.length > this.maxEntries || this.entriesBytes > this.maxBytes)) {
      this.entries.shift();
      this.entriesBytes -= this.entryBytes.shift() ?? 0;
    }
  }

  messages(): MessageDto[] {
    return buildMessages(selectActiveBranch(this.entries));
  }
}

/** pi 格式消息加载器：全量解析（scan.loadSessionMessages）+ 增量能力（tail 默认 loader） */
export const piMessageLoader: MessageLoader = Object.assign(
  (file: string): Promise<MessageDto[]> => loadSessionMessages(file),
  { createIncremental: (options?: IncrementalParserOptions): IncrementalParser => new PiIncrementalParser(options) },
);

/** 尾部残留是否为「整行已写完但缺换行符」（合法 JSON）；半行（写到一半）返回 false 留到下轮 */
function isCompleteJsonLine(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** rewrite 检测的尾部校验指纹字节数（原地重写 vs 追加的重叠区比对） */
const TAIL_FINGERPRINT_BYTES = 64;

/**
 * 读取 [from, EOF) 的新增字节 → 完整行列表 + 新偏移 + 已消费区的尾部指纹。
 * 偏移停在完整行边界（最后一个换行符之后）；尾部残留若是完整 JSON 行（缺换行符的
 * appendFile 场景）也消费，否则留到下轮（半行不解析）。按字节切分，UTF-8 多字节字符安全。
 * 尾部指纹（末 64 字节）供 detectChange 重叠区校验：原地重写（open "w" 截断重写）后
 * 同偏移处字节变了 → rewrite，防止把两代数据错位拼接。
 */
async function readNewLines(
  file: string,
  from: number,
): Promise<{ lines: string[]; nextOffset: number; tailFingerprint: Buffer }> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= from) return { lines: [], nextOffset: from, tailFingerprint: Buffer.alloc(0) };
    const buf = Buffer.allocUnsafe(size - from);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, from + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    const data = buf.subarray(0, filled);
    let consumed = data.lastIndexOf(0x0a) + 1; // 最后一个完整行边界
    const tail = data.subarray(consumed).toString("utf8");
    if (tail.trim() === "" || isCompleteJsonLine(tail)) consumed = filled;
    const chunk = data.subarray(0, consumed).toString("utf8");
    const lines = chunk.split("\n");
    if (chunk.endsWith("\n")) lines.pop(); // 行分隔符残留的空串
    const fpStart = Math.max(0, consumed - TAIL_FINGERPRINT_BYTES);
    return {
      lines,
      nextOffset: from + consumed,
      tailFingerprint: Buffer.from(data.subarray(fpStart, consumed)),
    };
  } finally {
    await handle.close();
  }
}

/** 文件静默多久后推断为 idle（与 presence 活动窗口一致：覆盖工具间思考的写盘间隙） */
const IDLE_AFTER_MS = 60_000;
/**
 * 回复落盘后的静默窗口（与普通写盘活动分开）：最后一条落盘消息是 assistant 文本消息
 * 时，短静默即视为本轮回复完成（用户体感“回复完按钮就该消失”），不再等 60 秒。
 * 多段回复/后续落盘会重新 pushRunning，不会卡在 idle。
 */
const IDLE_AFTER_REPLY_MS = 3_000;
/** 轮询间隔 */
const POLL_MS = 2_000;
/** 全量回退解析熔断：文件超过该大小时降频全量解析（无增量能力 loader 的 CPU/内存防护） */
const FULL_REPARSE_MAX_BYTES = 10 * 1024 * 1024;
/** 熔断后的全量解析最小间隔（大文件/高频变更时的降频目标） */
const FULL_REPARSE_MIN_INTERVAL_MS = 10_000;
/** 连续每轮都检测到变更达到此次数 → 视为高频写入（同样触发降频熔断） */
const HIGH_CHURN_TICKS = 3;

/** 测试可注入：轮询/静默窗口、全量回退熔断与内存窗口参数（生产用默认值） */
export interface TailOptions {
  pollMs?: number;
  idleAfterMs?: number;
  idleAfterReplyMs?: number;
  /** 全量回退熔断的文件大小阈值（缺省 10MB） */
  fullReparseMaxBytes?: number;
  /** 熔断后全量解析的最小间隔（缺省 10s） */
  fullReparseMinIntervalMs?: number;
  /** knownIds 环形上限（缺省 8192，P2-2） */
  knownIdsMax?: number;
  /** 全量回退解析只对账最近 N 条消息（缺省 4096，鉗制 ≤ knownIdsMax） */
  messageWindow?: number;
  /** 增量解析器 entry 条数窗口（缺省 1000，鉗制 ≤ knownIdsMax） */
  entryWindow?: number;
  /** 增量解析器 entry 字节窗口（缺省 2MB） */
  entryWindowBytes?: number;
}

interface TailState {
  ref: number;
  tail: SessionTail;
}

/** 按会话 id 复用 tail（ref 计数），供 WS 连接生命周期驱动 */
export class SessionTailManager {
  private readonly tails = new Map<string, TailState>();
  private readonly emit: EmitFn;
  private readonly options: TailOptions;

  constructor(emit: EmitFn, options: TailOptions = {}) {
    this.emit = emit;
    this.options = options;
  }

  acquire(sessionId: string, file: string, loader: MessageLoader = piMessageLoader): void {
    const existing = this.tails.get(sessionId);
    if (existing) {
      existing.ref += 1;
      return;
    }
    const tail = new SessionTail(sessionId, file, this.emit, loader, this.options);
    this.tails.set(sessionId, { ref: 1, tail });
    void tail.start();
  }

  release(sessionId: string): void {
    const state = this.tails.get(sessionId);
    if (!state) return;
    state.ref -= 1;
    if (state.ref <= 0) {
      state.tail.stop();
      this.tails.delete(sessionId);
    }
  }

  /** 供测试/诊断：某 tail 的 knownIds 驻留数（环形上限验证） */
  knownIdCount(sessionId: string): number {
    return this.tails.get(sessionId)?.tail.knownIdCount() ?? 0;
  }

  /**
   * 强制停掉某会话的 tail（不管 ref）：会话转 live 后由 SDK 事件单一推送，
   * 文件 tail 继续跑会把同一消息以不同 id 再推一遍（前端出重复气泡）。
   */
  detach(sessionId: string): void {
    const state = this.tails.get(sessionId);
    if (!state) return;
    state.tail.stop();
    this.tails.delete(sessionId);
  }

  stopAll(): void {
    for (const state of this.tails.values()) state.tail.stop();
    this.tails.clear();
  }
}

class SessionTail {
  private timer: NodeJS.Timeout | null = null;
  /** 已知消息 id（P2-2：环形上限 + FIFO 逐出，语义靠「窗口内不重复」） */
  private readonly knownIds = new Set<string>();
  private readonly knownIdRing: string[] = [];
  private lastChangeMs = 0;
  private runningPushed = false;
  private closed = false;
  /** 最近一次「assistant 回复落盘」时间；null=当前无回复静默计时（走长窗口） */
  private replyQuietMs: number | null = null;
  /** 文件指纹（size+mtime+ino）：未变则跳过解析（订阅静止会话零 CPU） */
  private lastSize = -1;
  private lastMtimeMs = -1;
  private lastIno = -1;
  /** 已消费区尾部指纹（末 64 字节）：重叠区校验区分 append 与原地重写 */
  private tailFingerprint: Buffer | null = null;
  /** 最近一次全量回退解析时刻（熔断降频用） */
  private fullParseAt = 0;
  /** 熔断跳过的解析待重试（变更被跳过后不得丢：下次窗口到达时补解析补推） */
  private pendingReparse = false;
  /** 连续检测到变更的轮数（达到阈值视为高频写入，触发降频熔断） */
  private churnStreak = 0;
  /** 重入保护：解析慢于轮询间隔时不让 tick 任务堆积（否则 CPU 高时正反馈恶化） */
  private ticking = false;
  /** 增量解析状态（loader 无增量能力时为 null → 全量解析回退） */
  private parser: IncrementalParser | null = null;
  /** 已解析字节偏移（停在完整行边界；半行留到下轮） */
  private parsedOffset = 0;
  private readonly pollMs: number;
  private readonly idleAfterMs: number;
  private readonly idleAfterReplyMs: number;
  private readonly fullReparseMaxBytes: number;
  private readonly fullReparseMinIntervalMs: number;
  /** knownIds 环形容量（≥ 窗口可产出 id 数，构造时鉗制） */
  private readonly knownIdsMax: number;
  /** 全量回退解析只对账最近 N 条消息（P2-2 窗口语义） */
  private readonly messageWindow: number;
  /** 传给增量解析器的窗口参数 */
  private readonly parserOptions: IncrementalParserOptions;

  constructor(
    private readonly sessionId: string,
    private readonly file: string,
    private readonly emit: EmitFn,
    private readonly loadMessages: MessageLoader = piMessageLoader,
    options: TailOptions = {},
  ) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.idleAfterReplyMs = options.idleAfterReplyMs ?? IDLE_AFTER_REPLY_MS;
    this.fullReparseMaxBytes = options.fullReparseMaxBytes ?? FULL_REPARSE_MAX_BYTES;
    this.fullReparseMinIntervalMs = options.fullReparseMinIntervalMs ?? FULL_REPARSE_MIN_INTERVAL_MS;
    this.knownIdsMax = Math.max(16, options.knownIdsMax ?? DEFAULT_KNOWN_IDS_MAX);
    // 窗口/环鉗制（P2-2 正确性前提）：消息窗口 ≤ entry 窗口 ≤ 环容量，
    // 保证窗口内可产出的 id 一定还在环里（不重推），环外 id 对应消息也一定出了窗（不补推）
    this.messageWindow = Math.max(1, Math.min(options.messageWindow ?? DEFAULT_MESSAGE_WINDOW, this.knownIdsMax));
    const entryWindow = Math.max(1, Math.min(options.entryWindow ?? DEFAULT_ENTRY_WINDOW, this.knownIdsMax));
    this.parserOptions = {
      maxEntries: entryWindow,
      maxBytes: options.entryWindowBytes ?? DEFAULT_ENTRY_WINDOW_BYTES,
    };
  }

  /** 供测试/诊断：knownIds 驻留数（环形上限验证） */
  knownIdCount(): number {
    return this.knownIds.size;
  }

  /** 登记已知 id（P2-2：环形 FIFO 逐出，超上限即丢最旧） */
  private remember(id: string): void {
    if (this.knownIds.has(id)) return;
    this.knownIds.add(id);
    this.knownIdRing.push(id);
    while (this.knownIdRing.length > this.knownIdsMax) {
      const evicted = this.knownIdRing.shift();
      if (evicted !== undefined) this.knownIds.delete(evicted);
    }
  }

  /** 消息窗口（P2-2）：全量回退只对账最近 N 条（新消息必在尾部；窗口内 id 必在环内） */
  private windowed(messages: MessageDto[]): MessageDto[] {
    return messages.length <= this.messageWindow ? messages : messages.slice(-this.messageWindow);
  }

  /**
   * 初始快照：把已有消息记入 known（客户端连接时已全量加载，不重复推送）。
   * ⚠️ 吞消息窗口修复：快照期间外部写入的新消息（晚于连接时刻）若只记 known 不推，
   * 本连接 UI 会永久缺消息（客户端全量加载发生在 tail 启动之前）。这类消息照常推送。
   */
  async start(): Promise<void> {
    const startedMs = Date.now();
    try {
      // 指纹先行：快照期间及其后的任何追加都会被下一轮变更检测捕获（不会被吞）
      const st = await stat(this.file);
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
      this.lastIno = st.ino;
      const createIncremental = this.loadMessages.createIncremental;
      let snapshot: MessageDto[];
      if (createIncremental) {
        // 增量路径：从偏移 0 喂入全部完整行建立状态（首帧即增量，无全量 parse；entry 窗口化驻留）
        this.parser = createIncremental(this.parserOptions);
        snapshot = await this.ingestFrom(0);
      } else {
        // 无增量能力（注入 loader）：安全回退全量解析（只对账消息窗口，P2-2）
        this.fullParseAt = Date.now();
        snapshot = this.windowed(await this.loadMessages(this.file));
      }
      this.applyStartSnapshot(snapshot, startedMs);
      this.lastChangeMs = Date.now();
    } catch {
      // 文件暂不可读：下一轮重试
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // 不阻止进程退出（closeAll/stop 会主动清理）
    this.timer.unref?.();
  }

  /** 初始快照 diff：晚于连接时刻的消息照常推送，其余只记 known（客户端已有） */
  private applyStartSnapshot(snapshot: readonly MessageDto[], startedMs: number): void {
    let changed = false;
    let lastNew: { role: string; text: string } | null = null;
    for (const m of snapshot) {
      // 严格晚于连接时刻才算快照窗口内的新消息（同毫秒落盘的历史消息不算，防重推）
      if (m.timestamp > startedMs) {
        changed = true;
        lastNew = { role: m.role, text: m.text };
        this.emit(this.sessionId, { type: "message_end", message: m });
      }
      this.remember(m.id);
    }
    if (changed) {
      this.pushRunning();
      this.replyQuietMs =
        lastNew !== null && lastNew.role === "assistant" && lastNew.text.trim() !== "" ? Date.now() : null;
    }
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 从字节偏移喂入完整行 → 当前消息序列（无新增行则不重算，knownIds 去重在 tick 兜底） */
  private async ingestFrom(from: number): Promise<MessageDto[]> {
    const { lines, nextOffset, tailFingerprint } = await readNewLines(this.file, from);
    this.parsedOffset = nextOffset;
    if (lines.length === 0) return [];
    this.tailFingerprint = tailFingerprint;
    for (const line of lines) this.parser?.pushLine(line);
    return this.parser?.messages() ?? [];
  }

  /**
   * 文件变更检测（size+mtime+ino 指纹 + 尾部重叠区校验）：
   * - none：未变，跳过解析
   * - append：正常追加（增量解析新增行）
   * - rewrite：原地截断重写 / 文件替换 / 尺寸未变的原地重写 → 重建增量状态全量对账
   *   （SDK `_rewriteFile` 是 open "w" 截断重写，新内容可能比旧内容长——只看 size 会误判
   *   append 而把两代数据错位拼接。用已消费区尾部指纹做重叠区校验：同偏移字节变了即重写。）
   * stat 失败按 append 处理（解析兜底）。
   */
  private async detectChange(): Promise<"none" | "append" | "rewrite"> {
    let size: number;
    let mtimeMs: number;
    let ino: number;
    try {
      const st = await stat(this.file);
      size = st.size;
      mtimeMs = st.mtimeMs;
      ino = st.ino;
    } catch {
      this.lastSize = -1;
      this.lastMtimeMs = -1;
      this.lastIno = -1;
      return "append";
    }
    const prevSize = this.lastSize;
    const prevMtimeMs = this.lastMtimeMs;
    this.lastSize = size;
    this.lastMtimeMs = mtimeMs;
    if (this.lastIno !== -1 && ino !== this.lastIno) {
      this.lastIno = ino;
      return "rewrite"; // 文件被替换/轮转（rename 新文件顶上）
    }
    this.lastIno = ino;
    if (size === prevSize && mtimeMs === prevMtimeMs) return "none";
    if (this.parser === null) return "append";
    if (size < this.parsedOffset) return "rewrite"; // 截断/轮转
    if (size === prevSize && size === this.parsedOffset && mtimeMs !== prevMtimeMs) return "rewrite"; // 尺寸未变但 mtime 变：原地重写疑点
    if (size > this.parsedOffset && this.tailFingerprint !== null && this.tailFingerprint.length > 0) {
      // 疑似追加：校验 [parsedOffset-指纹长, parsedOffset) 与上次消费尾部一致（重叠区不变才是真 append）
      const start = this.parsedOffset - this.tailFingerprint.length;
      const handle = await open(this.file, "r");
      try {
        const buf = Buffer.allocUnsafe(this.tailFingerprint.length);
        let filled = 0;
        while (filled < buf.length) {
          const { bytesRead } = await handle.read(buf, filled, buf.length - filled, start + filled);
          if (bytesRead <= 0) break;
          filled += bytesRead;
        }
        if (filled !== buf.length || !buf.equals(this.tailFingerprint)) return "rewrite";
      } finally {
        await handle.close();
      }
    }
    return "append";
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const change = await this.detectChange();
      if (change === "none" && !this.pendingReparse) {
        this.churnStreak = 0;
        // 文件未变：跳过解析，但静默推断照常推进（依赖时间而非文件内容）
        this.settleIfQuiet(Date.now());
        return;
      }
      if (change !== "none") this.churnStreak += 1;
      let messages: MessageDto[];
      if (this.parser !== null) {
        if (change === "rewrite") {
          // 全量对账：重建增量状态从 0 重喂（历史消息走 knownIds 去重，不重复推送）
          this.parser = this.loadMessages.createIncremental?.(this.parserOptions) ?? null;
          this.parsedOffset = 0;
          this.tailFingerprint = null;
        }
        messages = await this.ingestFrom(this.parsedOffset);
      } else {
        // 全量回退熔断（claude/codex transcript 无增量解析）：大文件或持续高频写入时
        // 降频全量重解析（每轮全量 parse 大会话曾是 CPU/内存尖峰源）。跳过的轮次不记
        // knownIds，下次解析窗口到达时照常补推（不丢，只延后）。
        const now0 = Date.now();
        const heavy = this.lastSize > this.fullReparseMaxBytes || this.churnStreak >= HIGH_CHURN_TICKS;
        if (heavy && now0 - this.fullParseAt < this.fullReparseMinIntervalMs) {
          this.pendingReparse = true; // 跳过的解析不得丢：窗口到达后补推
          this.lastChangeMs = now0;
          this.replyQuietMs = null; // 持续写入不是回复完成
          this.pushRunning();
          return;
        }
        this.fullParseAt = now0;
        this.pendingReparse = false;
        // P2-2：只对账最近 messageWindow 条（窗口内 id 必在 knownIds 环内，不重推；
        // 窗口外历史消息不再逐条比对，防 10MB transcript × 数万 id 驻留）
        messages = this.windowed(await this.loadMessages(this.file));
      }
      let changed = false;
      let lastNew: { role: string; text: string } | null = null;
      for (const m of messages) {
        if (this.knownIds.has(m.id)) continue;
        this.remember(m.id);
        changed = true;
        lastNew = { role: m.role, text: m.text };
        // 契约事件：message_end 携带权威消息（前端 upsert）
        this.emit(this.sessionId, { type: "message_end", message: m });
      }
      const now = Date.now();
      if (changed) {
        this.lastChangeMs = now;
        this.pushRunning();
        // 只有「本轮最后新增是 assistant 文本消息」才启动回复静默计时：
        // user/工具落盘说明新一轮或工具活动刚开始，维持长窗口避免误判
        this.replyQuietMs =
          lastNew !== null && lastNew.role === "assistant" && lastNew.text.trim() !== "" ? now : null;
      } else {
        this.settleIfQuiet(now);
      }
    } catch {
      // 单轮失败（文件损坏/写入中）忽略，下一轮重试
    } finally {
      this.ticking = false;
    }
  }

  /** 静默窗口推进：已推过 running 且够安静则收尾（与解析成本解耦） */
  private settleIfQuiet(now: number): void {
    if (!this.runningPushed) return;
    const replySettled = this.replyQuietMs !== null && now - this.replyQuietMs > this.idleAfterReplyMs;
    const silentSettled = now - this.lastChangeMs > this.idleAfterMs;
    if (replySettled || silentSettled) this.pushSettled();
  }

  /** 本轮工作结束：发契约 agent_settled（UI 恢复输入框、通知聚合），随后 status 回 idle */
  private pushSettled(): void {
    this.runningPushed = false;
    this.replyQuietMs = null;
    this.emit(this.sessionId, { type: "agent_settled" });
    this.emit(this.sessionId, { type: "status", status: "idle" });
    notifyStatusSinks(this.sessionId, "idle");
  }

  private pushRunning(): void {
    if (this.runningPushed) return;
    this.runningPushed = true;
    this.emit(this.sessionId, { type: "status", status: "running" });
    notifyStatusSinks(this.sessionId, "running");
  }
}

/** 外部活动推断：文件最近更新过则视为 running（本进程运行态优先由调用方处理） */
export function inferExternalStatus(updatedMs: number, nowMs = Date.now()): "running" | "idle" {
  return nowMs - updatedMs < IDLE_AFTER_MS ? "running" : "idle";
}

/** 供测试/诊断：解析当前文件已知消息 id 数 */
export async function peekMessageIds(file: string): Promise<string[]> {
  const messages = await loadSessionMessages(file);
  return messages.map((m) => m.id);
}
