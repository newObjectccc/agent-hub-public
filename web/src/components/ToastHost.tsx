import { useEffect, useState } from "react";
import { getToasts, subscribeToasts, type ToastItem } from "../utils/toast";

/** 全局 toast 宿主（复制成功等瞬时提示），挂在 App 根部 */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>(() => getToasts());
  useEffect(() => subscribeToasts(setToasts), []);
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status">
          {t.text}
        </div>
      ))}
    </div>
  );
}
