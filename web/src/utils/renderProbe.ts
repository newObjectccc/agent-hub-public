/**
 * 渲染探针（dev/test 专用）：统计组件渲染次数，验证 React.memo / useMemo 拦截效果
 * 与性能基准（改造前后渲染次数对比）。生产构建下 import.meta.env.DEV=false，
 * 整段被 bundler 消除，零运行时开销。
 */
export const renderProbe: Record<string, number> = {};

export function probeRender(name: string): void {
  if (import.meta.env.DEV) renderProbe[name] = (renderProbe[name] ?? 0) + 1;
}

export function probeCount(name: string): number {
  return renderProbe[name] ?? 0;
}

export function probeReset(): void {
  for (const key of Object.keys(renderProbe)) delete renderProbe[key];
}
