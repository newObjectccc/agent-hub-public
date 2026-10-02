import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./d-polish.css";
import "./e3-attach.css";
import "./f1-security.css";
import "./i1-layout.css"; /* i1 chat 布局精修（后加载覆盖：头部收纳/弹层铁律/树页贴边/子代理） */
import "./j1-header.css"; /* J1 顶栏图标按钮统一规范（后加载覆盖：icon-btn token/模式图标化/去运行中） */

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 注册 Service Worker（仅生产构建；dev 下避免干扰 HMR）
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[agent-hub] service worker 注册失败（不影响在线使用）", err);
    });
  });
}
