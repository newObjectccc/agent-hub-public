/**
 * 尾随 click 吞噬（一次性武装，模块级，跨组件共用）。
 *
 * 动机（三个旧竞态的统一替代）：
 * 1. 长按弹菜单后内核仍派发一记 click → 误触工具卡展开/思维链切换（旧 suppressClickRef
 *    只在 detector.end() 时置位，contextmenu 路径 cancel() 清 fired 后静默失效）；
 * 2. 点空白关菜单的"首次点击只关菜单不落到下方内容"（旧 swallowClick 随 effect cleanup
 *    被误删，也可能残留吞之后无关的一击）；
 * 3. 系统选词手势收尾的尾随 click → 误触 .code-copy / 按钮。
 *
 * 语义：arm() 后的**下一记 click**（短时窗内）被 preventDefault + stopPropagation 吞掉，
 * 随即自动解除；新 pointerdown 优先解除武装（新手势不该被吞）。模块级单例：同一时刻
 * 只有一个手势需要吞 click，不需要按组件实例化。
 */
const ARM_WINDOW_MS = 800;

let armedAt = 0;
let installed = false;

function onClickCapture(e: Event): void {
  // 键盘触发的合成 click（detail=0，无配对 pointer 事件）永不吃：残余武装下用户的
  // Enter/Space 激活不该被吞
  const detail = (e as MouseEvent).detail ?? 1;
  const withinWindow = Date.now() - armedAt <= ARM_WINDOW_MS;
  disarm();
  if (!withinWindow || detail === 0) return;
  e.preventDefault();
  e.stopPropagation();
}

function onPointerDownCapture(): void {
  // 新手势开始：之前武装的尾随 click 不会再是"同一手势"的误触，放行
  disarm();
}

function onPointerUpCapture(): void {
  // 时窗锚定在"松手"时刻：长按开菜单后用户可能继续按住看菜单 >800ms 才松，
  // 尾随 click 是松手时派发的——若时窗从武装时刻起算，慢松手就漏吞（误触脚部按钮）。
  // 每次 pointerup 刷新武装时间，吞的是"松手后那一击"。
  if (installed) armedAt = Date.now();
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // 捕获阶段拦截，任何 click 目标都吞得到（含 React 合成事件：stopPropagation 在
  // 原生捕获层拦住，React 根监听器不会再派发合成 click）
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("pointerdown", onPointerDownCapture, true);
  document.addEventListener("pointerup", onPointerUpCapture, true);
}

function disarm(): void {
  if (!installed) return;
  installed = false;
  armedAt = 0;
  if (typeof document === "undefined") return;
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("pointerdown", onPointerDownCapture, true);
  document.removeEventListener("pointerup", onPointerUpCapture, true);
}

/** 武装：吞掉即将来临的一记误触 click（长按/关菜单/选词手势收尾时调用） */
export function armTrailingClick(_x?: number, _y?: number): void {
  if (typeof document === "undefined") return;
  install();
  armedAt = Date.now();
}

/** 测试用：当前是否处于武装状态 */
export function isTrailingClickArmed(): boolean {
  return installed && Date.now() - armedAt <= ARM_WINDOW_MS;
}
