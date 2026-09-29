/**
 * 全局会话存在感知（presence）：
 * 首选 fs.watch 文件系统事件（macOS FSEvents / Windows / Linux recursive）——
 * 任一会话文件落盘即在 ~500ms 内触发 onChange（广播 sessions_changed），
 * 零轮询、零延迟感；watch 不可用的平台降级为 5s mtime 轮询。
 * 另保留 30s 低频兜底扫描（防漏事件）。
 */
import { watch, stat } from "node:fs";
import { stat as statPromise } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { findSessionFiles } from "./scan.js";

/** 事件驱动：文件事件的合并窗口（debounce） */
export const PRESENCE_DEBOUNCE_MS = 500;
/** 降级轮询间隔（watch 不可用时） */
export const PRESENCE_POLL_MS = 5_000;
/** 兜底扫描间隔（watch 可用时的低频校准） */
export const PRESENCE_FALLBACK_POLL_MS = 30_000;
/** 外部活动判定窗口：文件静默多久后认为不在运行（覆盖工具间思考的写盘间隙） */
export const ACTIVITY_WINDOW_MS = 60_000;

export class PresenceWatcher {
  private timer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
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
    // 优先文件系统事件（即时）；不可用则纯轮询
    let watching = false;
    try {
      this.watcher = watch(this.sessionDir, { recursive: true }, () => {
        this.scheduleNotify();
      });
      watching = true;
    } catch {
      this.watcher = null;
    }
    const interval = watching ? PRESENCE_FALLBACK_POLL_MS : PRESENCE_POLL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    try {
      this.watcher?.close();
    } catch {
      // 忽略
    }
    this.watcher = null;
  }

  /** 文件事件合并窗口：抖动内多事件只广播一次 */
  private scheduleNotify(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.closed) this.onChange();
    }, PRESENCE_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** 首次全量记账（不触发 onChange） */
  private async snapshot(): Promise<void> {
    const files = await findSessionFiles(this.sessionDir);
    for (const file of files) {
      try {
        const s = await statPromise(file);
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
          const s = await statPromise(file);
          const prev = this.mtimes.get(file);
          if (prev === undefined || s.mtimeMs > prev) {
            this.mtimes.set(file, s.mtimeMs);
            changed = true;
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
