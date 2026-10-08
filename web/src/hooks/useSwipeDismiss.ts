/**
 * 滑动关闭手势（AppShell 抽屉右滑同口径）：touchstart 记起点，touchend 判定位移。
 * - 只挂在提示条自身；不 preventDefault（React touch 监听为 passive），与 PullToRefresh / 页面滚动零冲突
 * - 滑动后浏览器会补一发合成 click（touchstart/touchend 同元素落点）：
 *   consumeSwipeClick 供 click 回调吞掉，避免"滑走横幅却顺手导航"的误触；
 *   新一轮 touchstart 复位标记，不会吞掉下一条提示的正常点击
 * - 手势只是功能性关闭（无动画路径），reduced-motion 用户不受影响
 */
import { useRef, type TouchEvent as ReactTouchEvent } from "react";
import { isSwipeDismiss, type TouchPointLike } from "../utils/swipe";

export interface SwipeDismissApi {
  onTouchStart: (e: ReactTouchEvent) => void;
  /** touchend 判定为滑动时调用 onDismiss（逐条传入各自的关闭动作） */
  onTouchEnd: (e: ReactTouchEvent, onDismiss: () => void) => void;
  /** 滑动刚发生后的合成 click 应忽略（消费一次返回 true） */
  consumeSwipeClick: () => boolean;
}

export function useSwipeDismiss(): SwipeDismissApi {
  const startRef = useRef<TouchPointLike | null>(null);
  const swipedRef = useRef(false);

  return {
    onTouchStart: (e) => {
      // 新一轮触摸复位：上一条提示滑动留下的标记不吞本次点击
      swipedRef.current = false;
      const t = e.touches[0];
      startRef.current = t ? { clientX: t.clientX, clientY: t.clientY } : null;
    },
    onTouchEnd: (e, onDismiss) => {
      const start = startRef.current;
      startRef.current = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      if (isSwipeDismiss(start, t)) {
        swipedRef.current = true;
        // 合成 click 紧随 touchend（同一事件循环回合内）；下一拍复位，
        // 键盘/读屏等无 touch 的后续 click 不被误吞
        setTimeout(() => {
          swipedRef.current = false;
        }, 0);
        onDismiss();
      }
    },
    consumeSwipeClick: () => {
      const swiped = swipedRef.current;
      swipedRef.current = false;
      return swiped;
    },
  };
}
