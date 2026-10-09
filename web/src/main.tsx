import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installUnhandledRejectionGuard } from "./utils/unhandledRejection";
import "./styles.css";
import "./d-polish.css";
import "./e3-attach.css";
import "./f1-security.css";
import "./i1-layout.css"; /* i1 chat 布局精修（后加载覆盖：头部收纳/弹层铁律/树页贴边/子代理） */
import "./j1-header.css"; /* J1 顶栏图标按钮统一规范（后加载覆盖：icon-btn token/模式图标化/去运行中） */

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// 首屏兜底握手（index.html inline 脚本）：React 已启动，超时/失败检测不再出错误卡
window.__APP_BOOTED__ = true;

// 未处理 Promise 拒绝全局兜底（P2）：dev console.warn / 生产安静，toast 提示不裸吞
installUnhandledRejectionGuard();

// 注册 Service Worker（仅生产构建；dev 下避免干扰 HMR）
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[agent-hub] service worker 注册失败（不影响在线使用）", err);
    });
  });
}
