/**
 * 轻量 toast 总线（复制成功等瞬时提示）。
 * 模块级单例 + 订阅，避免把回调一路 props 传到深层组件。
 *
 * 防刷屏（UX 审查）：
 * - 去重合并：同文案 toast 不叠加，只刷新它的存活时间并置顶（最新在尾部）
 * - 上限 TOAST_MAX 条：超出丢最旧的（含其定时器），toast 永不无限堆叠
 * - 可手动关闭：ToastHost 每条带 ✕（dismissToast 语义不变）
 */

export interface ToastItem {
  id: number;
  text: string;
}

export const TOAST_DURATION_MS = 2400;
/** 同屏 toast 条数上限（超出丢最旧） */
export const TOAST_MAX = 3;

type Listener = (toasts: ToastItem[]) => void;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  const snapshot = items.slice();
  for (const listener of listeners) listener(snapshot);
}

export function getToasts(): ToastItem[] {
  return items.slice();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(items.slice());
  return () => {
    listeners.delete(listener);
  };
}

/** 重置某条 toast 的自动消失计时（去重合并时“刷新”存活时间） */
function rearm(id: number): void {
  const prev = timers.get(id);
  if (prev !== undefined) clearTimeout(prev);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_DURATION_MS),
  );
}

export function showToast(text: string): void {
  // 去重合并：同文案已存在 → 置顶（挪到尾部）+ 重新计时，不新增条目
  const dup = items.find((t) => t.text === text);
  if (dup) {
    items = [...items.filter((t) => t.id !== dup.id), dup];
    emit();
    rearm(dup.id);
    return;
  }
  const id = ++seq;
  items = [...items, { id, text }];
  // 上限：丢最旧（连同它的定时器），防 toast 逐个堆满屏幕
  while (items.length > TOAST_MAX) {
    const dropped = items[0];
    items = items.slice(1);
    const timer = timers.get(dropped.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(dropped.id);
    }
  }
  emit();
  rearm(id);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}
