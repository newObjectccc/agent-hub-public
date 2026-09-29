/**
 * 全局会话存在感知（presence）：
 * 每 5 秒 stat 全部会话文件（廉价），检测 mtime 变化后触发 onChange（广播 sessions_changed）。
 * 让面板列表摆脱"打开时快照"：终端里跑的 pi 一落盘，手机列表几秒内自动刷新。
 */
import { stat } from "node:fs/promises";
import { findSessionFiles } from "./scan.js";

/** 扫描间隔 */
export const PRESENCE_POLL_MS = 5_000;
/** 外部活动判定窗口：文件静默多久后认为不在运行（覆盖工具间思考的写盘间隙） */
export const ACTIVITY_WINDOW_MS = 60_000;

export class PresenceWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly mtimes = new Map<string, number>();
  private readonly onChange: () => void;
  private readonly sessionDir: string;
  private closed = false;

  constructor(sessionDir: string, onChange: () => void) {
    this.sessionDir = sessionDir;
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    await this.snapshot();
    this.timer = setInterval(() => void this.tick(), PRESENCE_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 首次全量记账（不触发 onChange） */
  private async snapshot(): Promise<void> {
    const files = await findSessionFiles(this.sessionDir);
    for (const file of files) {
      try {
        const s = await stat(file);
        this.mtimes.set(file, s.mtimeMs);
      } catch {
        // 文件消失/不可读：忽略
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const files = await findSessionFiles(this.sessionDir);
      let changed = false;
      const seen = new Set<string>();
      for (const file of files) {
        seen.add(file);
        try {
          const s = await stat(file);
          const prev = this.mtimes.get(file);
          if (prev === undefined || s.mtimeMs > prev) {
            this.mtimes.set(file, s.mtimeMs);
            if (prev !== undefined) changed = true; // 新出现的文件也算变化
            else changed = true;
          }
        } catch {
          // 忽略
        }
      }
      // 文件被删除也算变化
      for (const known of this.mtimes.keys()) {
        if (!seen.has(known)) {
          this.mtimes.delete(known);
          changed = true;
        }
      }
      if (changed) this.onChange();
    } catch {
      // 单轮失败忽略
    }
  }
}
