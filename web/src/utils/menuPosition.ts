/**
 * 长按菜单定位纯函数：按压点锚定 + 视口 8px margin clamp + 放不下时上翻。
 *
 * 修复旧 bug：菜单绝对定位居中于 .msg-body（styles.css 旧规则 top:50%/left:50%），
 * 长消息（气泡高于视口）时菜单飞出屏幕外；窄气泡时横向溢出盖住相邻消息。
 * 改为锚定按压点（右键坐标 / 长按起点 / ⋯ 按钮中心），再向视口内 clamp。
 */

export interface MenuLayoutInput {
  /** 锚点（视口坐标） */
  anchorX: number;
  anchorY: number;
  /** 菜单实测尺寸（px）；jsdom/未挂载为 0 → 退化为锚点左上角 */
  width: number;
  height: number;
  /** 视口尺寸 */
  viewportWidth: number;
  viewportHeight: number;
  /** 视口边距（默认 8） */
  margin?: number;
  /** 纵向裁剪区（视口坐标）：菜单被滚动容器裁剪时须 clamp 进容器可见区，默认整个视口 */
  clipTop?: number;
  clipBottom?: number;
}

export interface MenuLayout {
  /** 菜单左上角（视口坐标） */
  left: number;
  top: number;
}

/**
 * 锚点居中放置，clamp 进视口（margin 内边距）；
 * 底部放不下自动上翻到锚点上方；菜单比视口还大时贴左上 margin 起点。
 * clipTop/clipBottom：消息菜单渲染在 .chat-messages 滚动容器内（超出被裁剪），
 * 纵向 clamp 必须以容器可见区为界而非 window.innerHeight。
 */
export function layoutMenu(input: MenuLayoutInput): MenuLayout {
  const m = input.margin ?? 8;
  const w = Math.max(0, input.width);
  const h = Math.max(0, input.height);
  const vw = Math.max(0, input.viewportWidth);
  const vh = Math.max(0, input.viewportHeight);
  const clipTop = Math.max(m, input.clipTop ?? m);
  const clipBottom = Math.min(vh - m, input.clipBottom ?? vh - m);

  // 默认：菜单中心压在锚点上
  let left = input.anchorX - w / 2;
  let top = input.anchorY - h / 2;

  // 横向 clamp：优先靠向锚点所在半屏，超界收回 margin
  left = clamp(left, m, vw - m - w);
  // 纵向：锚点下方（裁剪区内）放不下 → 上翻到锚点上方（仍放不下则贴上边）
  const below = input.anchorY + h / 2;
  if (below > clipBottom && input.anchorY - h / 2 - h / 2 >= clipTop) {
    top = input.anchorY - h - m / 2;
  }
  top = clamp(top, clipTop, clipBottom - h);

  return { left, top };
}

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min; // 视口比菜单小：贴 margin 起点
  return Math.min(Math.max(v, min), max);
}
