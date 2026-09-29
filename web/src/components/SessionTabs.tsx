/**
 * 会话列表横向滚动 tab 组（野兽派）：[全部] [🔥工作中] [⚠️等你处理] [✅今日完成]。
 * - 横向排布，超宽可横滑（.tab-scroll overflow-x），触控目标 ≥44px；
 * - active 滑块动画：一个绝对定位滑块（野兽派硬阴影底色）用 transform/width transition
 *   220ms 平滑滑到选中 tab；首帧定位不播动画（动画只在真实交互时发生）；
 * - 切换即时过滤（父级已过滤数据），无闪烁；计数徽标常驻。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SESSION_TABS, type SessionTab } from "../utils/sessionTabs";
import { cn } from "@/lib/utils";

export function SessionTabs({
  value,
  counts,
  onChange,
}: {
  value: SessionTab;
  counts: Record<SessionTab, number>;
  onChange: (tab: SessionTab) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Partial<Record<SessionTab, HTMLButtonElement | null>>>({});
  const [slider, setSlider] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  /** 首帧（挂载/水合）定位不播动画，之后用户切换才播滑块 transition */
  const [ready, setReady] = useState(false);
  const firstRef = useRef(true);

  // 滑块跟随选中 tab（测量按钮 offsetLeft/offsetWidth，与滚动位置无关）
  useLayoutEffect(() => {
    const btn = btnRefs.current[value];
    if (!btn) return;
    setSlider({ left: btn.offsetLeft, width: btn.offsetWidth });
    if (firstRef.current) {
      firstRef.current = false;
      requestAnimationFrame(() => setReady(true));
      return;
    }
    // 真实切换：把选中 tab 滚入可视区（仅横向容器滚动，不带动页面）
    const scroller = scrollerRef.current;
    if (scroller) {
      const left = btn.offsetLeft;
      const right = left + btn.offsetWidth;
      const viewLeft = scroller.scrollLeft;
      const viewRight = viewLeft + scroller.clientWidth;
      if (left < viewLeft) {
        if (typeof scroller.scrollTo === "function") scroller.scrollTo({ left, behavior: "smooth" });
        else scroller.scrollLeft = left;
      } else if (right > viewRight) {
        const target = right - scroller.clientWidth;
        if (typeof scroller.scrollTo === "function") scroller.scrollTo({ left: target, behavior: "smooth" });
        else scroller.scrollLeft = target;
      }
    }
  }, [value]);

  // 视口/布局变化（旋转、字号、桌面拖宽）→ 重新测量滑块
  useEffect(() => {
    const remeasure = (): void => {
      const btn = btnRefs.current[value];
      if (btn) setSlider({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    window.addEventListener("resize", remeasure);
    if (typeof ResizeObserver !== "undefined" && scrollerRef.current) {
      const ro = new ResizeObserver(remeasure);
      ro.observe(scrollerRef.current);
      return () => {
        window.removeEventListener("resize", remeasure);
        ro.disconnect();
      };
    }
    return () => window.removeEventListener("resize", remeasure);
  }, [value]);

  return (
    <div className="tab-scroll" ref={scrollerRef}>
      <div className="tab-group" role="tablist" aria-label="会话过滤">
        <span
          className={cn("tab-slider", ready && "ready")}
          style={{ transform: `translateX(${slider.left}px)`, width: `${slider.width}px` }}
          aria-hidden
        />
        {SESSION_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            ref={(el) => {
              btnRefs.current[tab.value] = el;
            }}
            aria-selected={value === tab.value}
            className={cn("tab-btn", value === tab.value && "active")}
            onClick={() => onChange(tab.value)}
          >
            <span>{tab.label}</span>
            <span className="tab-count">{counts[tab.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
