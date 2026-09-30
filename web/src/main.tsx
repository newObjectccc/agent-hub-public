import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./d-polish.css";
import "./e3-attach.css";

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
