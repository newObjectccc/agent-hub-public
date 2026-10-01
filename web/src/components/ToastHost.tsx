import { useEffect, useState } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from "../utils/toast";

/** 全局 toast 宿主（复制成功等瞬时提示），挂在 App 根部；每条可手动 ✕ 关闭 */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>(() => getToasts());
  useEffect(() => subscribeToasts(setToasts), []);
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status">
          <span className="toast-text">{t.text}</span>
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
