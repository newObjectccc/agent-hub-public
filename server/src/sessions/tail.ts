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
 */
import { open, stat } from "node:fs/promises";
import { buildMessages, loadSessionMessages, selectActiveBranch, type RawEntry } from "./scan.js";
import type { MessageDto } from "../types.js";
import type { EmitFn } from "./hub.js";

/** 增量解析器：只吃新增完整行，产出当前应有的消息序列（调用方 knownIds 去重后推送） */
export interface IncrementalParser {
  /** 喂入一行原始 JSONL 文本（不含换行符）；坏行/不识别行静默跳过 */
  pushLine(line: string): void;
  /** 当前累积状态下的消息列表（与全量解析同 id、同顺序） */
  messages(): MessageDto[];
}

/** 消息加载器：按会话文件格式注入（pi session-format / claude transcript） */
export interface MessageLoader {
  (file: string): Promise<MessageDto[]>;
  /** 可选增量能力（pi 格式自带）；缺失时 tail 安全回退全量解析 */
  createIncremental?: () => IncrementalParser;
}

/**
 * pi session-format v3 增量解析器：按行解析 entry（与 scan.parseSessionJsonl 同规则），
 * 复用 selectActiveBranch + buildMessages 纯函数产出消息（与 loadSessionMessages 同口径）。
 * 只对新增行做 JSON.parse；历史 entries 驻留内存供分支选择（活跃 tail = 当前打开的会话）。
 */
export class PiIncrementalParser implements IncrementalParser {
  private readonly entries: RawEntry[] = [];
  private headerSeen = false;

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
  }

  messages(): MessageDto[] {
    return buildMessages(selectActiveBranch(this.entries));
  }
}

/** pi 格式消息加载器：全量解析（scan.loadSessionMessages）+ 增量能力（tail 默认 loader） */
export const piMessageLoader: MessageLoader = Object.assign(
  (file: string): Promise<MessageDto[]> => loadSessionMessages(file),
  { createIncremental: (): IncrementalParser => new PiIncrementalParser() },
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

/**
 * 读取 [from, EOF) 的新增字节 → 完整行列表 + 新偏移。
 * 偏移停在完整行边界（最后一个换行符之后）；尾部残留若是完整 JSON 行（缺换行符的
 * appendFile 场景）也消费，否则留到下轮（半行不解析）。按字节切分，UTF-8 多字节字符安全。
 */
async function readNewLines(file: string, from: number): Promise<{ lines: string[]; nextOffset: number }> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= from) return { lines: [], nextOffset: from };
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
    return { lines, nextOffset: from + consumed };
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

/** 测试可注入：轮询/静默窗口（生产用默认值） */
export interface TailOptions {
  pollMs?: number;
  idleAfterMs?: number;
  idleAfterReplyMs?: number;
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
  private readonly knownIds = new Set<string>();
  private lastChangeMs = 0;
  private runningPushed = false;
  private closed = false;
  /** 最近一次「assistant 回复落盘」时间；null=当前无回复静默计时（走长窗口） */
  private replyQuietMs: number | null = null;
  /** 文件指纹（size+mtime）：未变则跳过解析（订阅静止会话零 CPU） */
  private lastSize = -1;
  private lastMtimeMs = -1;
  /** 重入保护：解析慢于轮询间隔时不让 tick 任务堆积（否则 CPU 高时正反馈恶化） */
  private ticking = false;
  /** 增量解析状态（loader 无增量能力时为 null → 全量解析回退） */
  private parser: IncrementalParser | null = null;
  /** 已解析字节偏移（停在完整行边界；半行留到下轮） */
  private parsedOffset = 0;
  private readonly pollMs: number;
  private readonly idleAfterMs: number;
  private readonly idleAfterReplyMs: number;

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
  }

  /** 初始快照：把已有消息全部记入 known（不推送——客户端连接时已全量加载） */
  async start(): Promise<void> {
    try {
      // 指纹先行：快照期间及其后的任何追加都会被下一轮变更检测捕获（不会被吞）
      const st = await stat(this.file);
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
      const createIncremental = this.loadMessages.createIncremental;
      if (createIncremental) {
        // 增量路径：从偏移 0 喂入全部完整行建立状态（首帧即增量，无全量 parse）
        this.parser = createIncremental();
        for (const m of await this.ingestFrom(0)) this.knownIds.add(m.id);
      } else {
        // 无增量能力（注入 loader）：安全回退全量解析
        const messages = await this.loadMessages(this.file);
        for (const m of messages) this.knownIds.add(m.id);
      }
      this.lastChangeMs = Date.now();
    } catch {
      // 文件暂不可读：下一轮重试
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // 不阻止进程退出（closeAll/stop 会主动清理）
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 从字节偏移喂入完整行 → 当前消息序列（无新增行则不重算，knownIds 去重在 tick 兜底） */
  private async ingestFrom(from: number): Promise<MessageDto[]> {
    const { lines, nextOffset } = await readNewLines(this.file, from);
    this.parsedOffset = nextOffset;
    if (lines.length === 0) return [];
    for (const line of lines) this.parser?.pushLine(line);
    return this.parser?.messages() ?? [];
  }

  /**
   * 文件变更检测（size+mtime 双指纹）：
   * - none：未变，跳过解析
   * - append：正常追加（增量解析新增行）
   * - rewrite：截断/尺寸未变的原地重写疑点 → 重建增量状态全量对账（knownIds 兜底不重）
   * stat 失败按 append 处理（解析兜底）。
   */
  private async detectChange(): Promise<"none" | "append" | "rewrite"> {
    let size: number;
    let mtimeMs: number;
    try {
      const st = await stat(this.file);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      this.lastSize = -1;
      this.lastMtimeMs = -1;
      return "append";
    }
    const prevSize = this.lastSize;
    const prevMtimeMs = this.lastMtimeMs;
    this.lastSize = size;
    this.lastMtimeMs = mtimeMs;
    if (size === prevSize && mtimeMs === prevMtimeMs) return "none";
    if (this.parser === null) return "append";
    if (size < this.parsedOffset) return "rewrite"; // 截断/轮转
    if (size === prevSize && size === this.parsedOffset && mtimeMs !== prevMtimeMs) return "rewrite"; // 尺寸未变但 mtime 变：原地重写疑点
    return "append";
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const change = await this.detectChange();
      if (change === "none") {
        // 文件未变：跳过解析，但静默推断照常推进（依赖时间而非文件内容）
        this.settleIfQuiet(Date.now());
        return;
      }
      let messages: MessageDto[];
      if (this.parser !== null) {
        if (change === "rewrite") {
          // 全量对账：重建增量状态从 0 重喂（历史消息走 knownIds 去重，不重复推送）
          this.parser = this.loadMessages.createIncremental?.() ?? null;
          this.parsedOffset = 0;
        }
        messages = await this.ingestFrom(this.parsedOffset);
      } else {
        messages = await this.loadMessages(this.file);
      }
      let changed = false;
      let lastNew: { role: string; text: string } | null = null;
      for (const m of messages) {
        if (this.knownIds.has(m.id)) continue;
        this.knownIds.add(m.id);
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
  }

  private pushRunning(): void {
    if (this.runningPushed) return;
    this.runningPushed = true;
    this.emit(this.sessionId, { type: "status", status: "running" });
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
