/**
 * 移动端键盘避让：visualViewport 监听 resize/scroll，计算「布局视口被键盘遮住的高度」，
 * 由页面层写入 CSS 变量（--kb-inset）抬高输入区，消息区保持可见滚动。
 * 不支持 visualViewport 的环境（桌面/旧浏览器）恒 0，静默降级。
 */
import { useEffect, useState } from "react";

/** 纯计算：布局高度 - 可视视口高度 - 顶部偏移 = 底部被遮高度（键盘/工具栏） */
export function computeInset(layoutHeight: number, viewportHeight: number, offsetTop: number): number {
  const gap = layoutHeight - viewportHeight - offsetTop;
  return gap > 0 ? Math.round(gap) : 0;
}

export function useVisualViewportInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(computeInset(window.innerHeight, vv.height, vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
