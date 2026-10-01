/**
 * 会话列表横向滚动 tab 组（野兽派）：[全部] [🔥工作中] [⚠️等你处理] [✅今日完成]。
 * - 横向排布，超宽可横滑（.tab-scroll overflow-x），触控目标 ≥44px；
 * - active 滑块动画：一个绝对定位滑块（野兽派硬阴影底色）用 transform/width transition
 *   220ms 平滑滑到选中 tab；首帧定位不播动画（动画只在真实交互时发生）；
 * - **滑块定位不依赖挂载瞬间一次测量**（老病根：counts/字体迟到导致按钮变宽、滑块不跟）：
 *   多源重测（rAF 门控）——选中值/counts 变化、逐按钮 ResizeObserver、字体加载完成、
 *   视口/visualViewport resize、页面可见性（visibilitychange/pageshow/focus）返回；
 * - **测量失败自愈**：定位值与按钮实际布局不符（>1px）时滑块隐藏，由纯 CSS 兜底
 *   （.tab-slider.misaligned ~ .tab-btn.active 自带底色）——任何时刻 active 态都正确，
 *   不存在"滑块错位/宽度不对"的中间态；
 * - 切换即时过滤（父级已过滤数据），无闪烁；计数徽标常驻。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SESSION_TABS, type SessionTab } from "../utils/sessionTabs";
import { cn } from "@/lib/utils";

/** 对齐容差（px）：定位值与按钮实际布局偏差超过它即视为测量失效 */
const ALIGN_TOLERANCE_PX = 1;

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
  const groupRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Partial<Record<SessionTab, HTMLButtonElement | null>>>({});
  const [slider, setSlider] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  /** 首帧（挂载/水合）定位不播动画，之后用户切换才播滑块 transition */
  const [ready, setReady] = useState(false);
  /** 测量失配：滑块隐藏 + active 按钮纯 CSS 兜底（见 styles.css .tab-slider.misaligned） */
  const [misaligned, setMisaligned] = useState(false);
  /** 下一次定位允许播动画（仅用户点击切换触发） */
  const animateNextRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  /** 返回导航保护窗口：挂载后短时间内非交互横滚一律校正回 0（#6 tab 左侧 padding 被覆盖） */
  const guardUntilRef = useRef(0);
  const interactedRef = useRef(false);

  // #6：从会话返回列表时，浏览器焦点/滚动恢复会把 tab 组横滚拉偏（左侧 padding 被"覆盖"）。
  // 挂载即归零 + 短窗口内非用户交互的横滚一律校正回 0；用户 touch/wheel/pointer 交互后放行横滑。
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    guardUntilRef.current = Date.now() + 800;
    interactedRef.current = false;
    scroller.scrollLeft = 0;
    const markInteracted = (): void => {
      interactedRef.current = true;
    };
    const onScroll = (): void => {
      if (!interactedRef.current && Date.now() < guardUntilRef.current && scroller.scrollLeft !== 0) {
        scroller.scrollLeft = 0;
      }
    };
    scroller.addEventListener("touchstart", markInteracted, { passive: true });
    scroller.addEventListener("wheel", markInteracted, { passive: true });
    scroller.addEventListener("pointerdown", markInteracted, { passive: true });
    scroller.addEventListener("scroll", onScroll);
    // 晚到的滚动恢复（rAF 后）再归零一次，覆盖时序在挂载帧之后的恢复
    const raf = requestAnimationFrame(() => {
      if (!interactedRef.current && scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
    });
    return () => {
      scroller.removeEventListener("touchstart", markInteracted);
      scroller.removeEventListener("wheel", markInteracted);
      scroller.removeEventListener("pointerdown", markInteracted);
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  /** 测量并同步滑块位置（跟随选中 tab 的 offsetLeft/offsetWidth，与滚动位置无关） */
  const measure = useCallback(() => {
    const btn = btnRefs.current[value];
    if (!btn) return;
    const left = btn.offsetLeft;
    const width = btn.offsetWidth;
    // 布局不可测（未布局/隐藏/字体未就绪）：不写入 0 宽滑块，走纯 CSS 兜底（active 自带底色）
    if (width <= 0) {
      setMisaligned(true);
      return;
    }
    setMisaligned(false);
    setSlider({ left, width });
  }, [value]);

  /** rAF 门控重测：合并同帧多次触发（ResizeObserver/字体/可见性风暴） */
  const scheduleMeasure = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  // 选中值 / 计数（徽标宽度）变化 → 同步测量；仅用户点击切换播动画
  useLayoutEffect(() => {
    measure();
    if (animateNextRef.current) {
      animateNextRef.current = false;
      setReady(true);
    }
  }, [value, counts, measure]);

  // 测量自检：定位值必须与按钮当前实际布局一致，否则隐藏滑块走纯 CSS 兜底
  useEffect(() => {
    const btn = btnRefs.current[value];
    if (!btn) return;
    const check = (): void => {
      const width = btn.offsetWidth;
      if (width <= 0) return; // jsdom / 隐藏态不做判定（布局不可测）
      const ok =
        Math.abs(btn.offsetLeft - slider.left) <= ALIGN_TOLERANCE_PX &&
        Math.abs(width - slider.width) <= ALIGN_TOLERANCE_PX;
      setMisaligned(!ok);
    };
    check();
  }, [slider, value]);

  // 视口/布局变化（旋转、字号、桌面拖宽、键盘弹出收起）→ 重新测量滑块
  useEffect(() => {
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("focus", scheduleMeasure);
    // 路由返回/后台切回（bfcache pageshow、标签页可见）→ 重测，杜绝"返回后滑块错位"
    window.addEventListener("pageshow", scheduleMeasure);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") scheduleMeasure();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 键盘弹出/收起、地址栏伸缩改变 visualViewport 尺寸
    window.visualViewport?.addEventListener("resize", scheduleMeasure);

    const cleanups: Array<() => void> = [
      () => window.removeEventListener("resize", scheduleMeasure),
      () => window.removeEventListener("focus", scheduleMeasure),
      () => window.removeEventListener("pageshow", scheduleMeasure),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => window.visualViewport?.removeEventListener("resize", scheduleMeasure),
    ];

    // 逐按钮 + 容器 ResizeObserver：counts 字体加载/换行/主题切换引起按钮宽度变化也能跟上
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(scheduleMeasure);
      if (scrollerRef.current) ro.observe(scrollerRef.current);
      if (groupRef.current) ro.observe(groupRef.current);
      for (const tab of SESSION_TABS) {
        const el = btnRefs.current[tab.value];
        if (el) ro.observe(el);
      }
      cleanups.push(() => ro.disconnect());
    }

    // Web 字体加载完成会改变按钮宽度（nb-font-head 是自定义字体），完成后重测
    if (typeof document !== "undefined" && document.fonts) {
      const fonts = document.fonts;
      void fonts.ready.then(scheduleMeasure).catch(() => undefined);
      fonts.addEventListener?.("loadingdone", scheduleMeasure);
      cleanups.push(() => fonts.removeEventListener?.("loadingdone", scheduleMeasure));
    }

    // 挂载帧后再测一次（rAF 门控）：覆盖挂载瞬间之后才稳定的布局
    scheduleMeasure();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      for (const fn of cleanups) fn();
    };
  }, [scheduleMeasure]);

  // 真实切换：把选中 tab 滚入可视区（仅横向容器滚动，不带动页面）
  useEffect(() => {
    if (!ready) return;
    const btn = btnRefs.current[value];
    const scroller = scrollerRef.current;
    if (!btn || !scroller) return;
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
  }, [value, ready]);

  return (
    <div className="tab-scroll" ref={scrollerRef}>
      <div className="tab-group" role="tablist" aria-label="会话过滤" ref={groupRef}>
        <span
          className={cn("tab-slider", ready && "ready", misaligned && "misaligned")}
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
            onClick={() => {
              // 动画只在真实用户切换时播（首帧/重挂载/外部重测不播）
              if (tab.value !== value) animateNextRef.current = true;
              onChange(tab.value);
            }}
          >
            <span>{tab.label}</span>
            <span className="tab-count">{counts[tab.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
