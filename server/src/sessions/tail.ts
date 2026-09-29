/**
 * 会话文件实时观察（live tail）：
 * 非本进程启动的会话（终端里跑的 pi 等）没有 SDK 事件流，这里轮询 JSONL 文件、
 * diff 出新增消息后按契约推送 `message_end`（前端 reducer 同 id 覆盖、新 id 追加，零改动兼容），
 * 并推断运行态：文件持续写入 → status:"running"，静默 → status:"idle"。
 */
import { loadSessionMessages } from "./scan.js";
import type { MessageDto } from "../types.js";
import type { EmitFn } from "./hub.js";

/** 消息加载器：按会话文件格式注入（pi session-format / claude transcript） */
export type MessageLoader = (file: string) => Promise<MessageDto[]>;

/** 文件静默多久后推断为 idle（与 presence 活动窗口一致：覆盖工具间思考的写盘间隙） */
const IDLE_AFTER_MS = 60_000;
/** 轮询间隔 */
const POLL_MS = 2_000;

interface TailState {
  ref: number;
  tail: SessionTail;
}

/** 按会话 id 复用 tail（ref 计数），供 WS 连接生命周期驱动 */
export class SessionTailManager {
  private readonly tails = new Map<string, TailState>();
  private readonly emit: EmitFn;

  constructor(emit: EmitFn) {
    this.emit = emit;
  }

  acquire(sessionId: string, file: string, loader: MessageLoader = loadSessionMessages): void {
    const existing = this.tails.get(sessionId);
    if (existing) {
      existing.ref += 1;
      return;
    }
    const tail = new SessionTail(sessionId, file, this.emit, loader);
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

  constructor(
    private readonly sessionId: string,
    private readonly file: string,
    private readonly emit: EmitFn,
    private readonly loadMessages: MessageLoader = loadSessionMessages,
  ) {}

  /** 初始快照：把已有消息全部记入 known（不推送——客户端连接时已全量加载） */
  async start(): Promise<void> {
    try {
      const messages = await this.loadMessages(this.file);
      for (const m of messages) this.knownIds.add(m.id);
      this.lastChangeMs = Date.now();
    } catch {
      // 文件暂不可读：下一轮重试
    }
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    // 不阻止进程退出（closeAll/stop 会主动清理）
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const messages = await this.loadMessages(this.file);
      let changed = false;
      for (const m of messages) {
        if (this.knownIds.has(m.id)) continue;
        this.knownIds.add(m.id);
        changed = true;
        // 契约事件：message_end 携带权威消息（前端 upsert）
        this.emit(this.sessionId, { type: "message_end", message: m });
      }
      if (changed) {
        this.lastChangeMs = Date.now();
        this.pushRunning();
      } else if (this.runningPushed && Date.now() - this.lastChangeMs > IDLE_AFTER_MS) {
        this.runningPushed = false;
        // 文件静默 = 外部会话本轮工作结束：发契约 agent_settled（UI 恢复输入框、
        // 通知聚合出“干完等你处理”），随后 status 回 idle（与 SessionHub 顺序一致）
        this.emit(this.sessionId, { type: "agent_settled" });
        this.emit(this.sessionId, { type: "status", status: "idle" });
      }
    } catch {
      // 单轮失败（文件损坏/写入中）忽略，下一轮重试
    }
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
