/**
 * 长按识别（触屏 long-press / 鼠标长按通用）：纯状态机 + 可注入定时器，便于 mock timer 测试。
 *
 * 规则：
 * - 按下后 delayMs 内未移动超过 moveTolerancePx 且未抬起 → 触发一次长按
 * - 移动超容差（滚动/拖拽）立即取消，避免与页面滚动冲突
 * - end() 返回本次是否触发过长按，供调用方抑制后续 click（避免"长按后又点开"）
 */

export interface LongPressOptions {
  /** 触发时长（ms） */
  delayMs?: number;
  /** 允许移动容差（px），超出即取消 */
  moveTolerancePx?: number;
  /** 注入定时器便于测试 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const LONG_PRESS_DELAY_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 12;

export class LongPressDetector {
  private readonly onFire: () => void;
  private readonly delayMs: number;
  private readonly moveTolerancePx: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private timer: unknown = null;
  private startX = 0;
  private startY = 0;
  private pressing = false;
  private fired = false;

  constructor(onFire: () => void, options: LongPressOptions = {}) {
    this.onFire = onFire;
    this.delayMs = options.delayMs ?? LONG_PRESS_DELAY_MS;
    this.moveTolerancePx = options.moveTolerancePx ?? LONG_PRESS_MOVE_TOLERANCE_PX;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(x: number, y: number): void {
    this.cancel();
    this.pressing = true;
    this.fired = false;
    this.startX = x;
    this.startY = y;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.pressing) return;
      this.pressing = false;
      this.fired = true;
      this.onFire();
    }, this.delayMs);
  }

  move(x: number, y: number): void {
    if (!this.pressing) return;
    if (Math.abs(x - this.startX) > this.moveTolerancePx || Math.abs(y - this.startY) > this.moveTolerancePx) {
      this.cancel();
    }
  }

  /** 抬起/结束：返回本次手势是否触发了长按（并复位状态） */
  end(): boolean {
    const fired = this.fired;
    this.cancel();
    return fired;
  }

  /** 中止当前手势（移动超容差 / pointercancel / 组件卸载） */
  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.pressing = false;
    this.fired = false;
  }
}
