/**
 * 轻量 toast 总线（复制成功等瞬时提示）。
 * 模块级单例 + 订阅，避免把回调一路 props 传到深层组件。
 */

export interface ToastItem {
  id: number;
  text: string;
}

export const TOAST_DURATION_MS = 2400;

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

export function showToast(text: string): void {
  const id = ++seq;
  items = [...items, { id, text }];
  emit();
  const timer = setTimeout(() => dismissToast(id), TOAST_DURATION_MS);
  timers.set(id, timer);
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
