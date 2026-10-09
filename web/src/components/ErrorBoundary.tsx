/**
 * 顶层 ErrorBoundary（首屏可靠性 #5）：React 渲染/生命周期抛异常时不黑屏——
 * 显示友好错误卡（非黑屏），带「重试」（重置边界重新渲染）与「刷新页面」（location.reload）。
 * 挂载于 main.tsx 中 App 外层；与 index.html 首屏兜底互补（那边管 JS 没跑起来，这边管跑起来后炸了）。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 测试可注入刷新出口；默认 location.reload */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 默认刷新出口（单独导出便于测试断言默认行为是 reload） */
export function reloadPage(): void {
  window.location.reload();
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留排查线索（远程诊断首屏白屏/黑屏问题用），不吞栈
    console.error("[agent-hub] 渲染异常", error, info.componentStack);
  }

  private retry = (): void => {
    // 重置边界 → 重新渲染 children；若仍抛错会再次落回本卡片
    this.setState({ error: null });
  };

  private reload = (): void => {
    (this.props.onReload ?? reloadPage)();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
          <div role="alert" className="card flex w-full max-w-sm flex-col gap-3 p-4">
            <div className="font-head text-xl">页面出错了</div>
            <p className="text-sm text-muted-foreground">应用渲染时发生异常，请重试或刷新页面。</p>
            <div className="flex gap-2">
              <Button onClick={this.retry}>重试</Button>
              <Button variant="secondary" onClick={this.reload}>
                刷新页面
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
