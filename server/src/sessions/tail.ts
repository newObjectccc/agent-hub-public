/**
 * 会话文件实时观察（live tail）：
 * 非本进程启动的会话（终端里跑的 pi 等）没有 SDK 事件流，这里轮询 JSONL 文件、
 * diff 出新增消息后按契约推送 `message_end`（前端 reducer 同 id 覆盖、新 id 追加，零改动兼容），
 * 并推断运行态：文件持续写入 → status:"running"，静默 → status:"idle"。
 */
import { stat } from "node:fs/promises";
import { loadSessionMessages } from "./scan.js";
import type { MessageDto } from "../types.js";
import type { EmitFn } from "./hub.js";

/** 消息加载器：按会话文件格式注入（pi session-format / claude transcript） */
export type MessageLoader = (file: string) => Promise<MessageDto[]>;

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

  acquire(sessionId: string, file: string, loader: MessageLoader = loadSessionMessages): void {
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
  /** 文件指纹（size+mtime）：未变则跳过全量解析（订阅静止会话零 CPU） */
  private lastSize = -1;
  private lastMtimeMs = -1;
  /** 重入保护：解析慜于轮询间隔时不让 tick 任务堆积（否则 CPU 高时正反馈恶化） */
  private ticking = false;
  private readonly pollMs: number;
  private readonly idleAfterMs: number;
  private readonly idleAfterReplyMs: number;

  constructor(
    private readonly sessionId: string,
    private readonly file: string,
    private readonly emit: EmitFn,
    private readonly loadMessages: MessageLoader = loadSessionMessages,
    options: TailOptions = {},
  ) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.idleAfterReplyMs = options.idleAfterReplyMs ?? IDLE_AFTER_REPLY_MS;
  }

  /** 初始快照：把已有消息全部记入 known（不推送——客户端连接时已全量加载） */
  async start(): Promise<void> {
    try {
      const messages = await this.loadMessages(this.file);
      for (const m of messages) this.knownIds.add(m.id);
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

  /** 文件是否自上次解析后变更（size+mtime 双指纹）；stat 失败按变更处理（解析兕底） */
  private async isChanged(): Promise<boolean> {
    try {
      const st = await stat(this.file);
      if (st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) return false;
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
      return true;
    } catch {
      return true;
    }
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      if (await this.isChanged()) {
        const messages = await this.loadMessages(this.file);
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
      } else {
        // 文件未变：跳过全量解析，但静默推断照常推进（依赖时间而非文件内容）
        this.settleIfQuiet(Date.now());
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
