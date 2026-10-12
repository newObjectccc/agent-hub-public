/// <reference types="vite/client" />

/** 构建期注入的 web 包版本号（关于页显示；见 vite.config.ts define） */
declare const __APP_VERSION__: string;

/**
 * 首屏兜底握手标志（index.html inline 脚本维护）：React 启动后 main.tsx 置 true，
 * inline 超时/失败检测据此决定是否显示「资源加载失败」错误卡。
 */
interface Window {
  __APP_BOOTED__?: boolean;
}

/** 构建出处（git short SHA，构建期注入）：产物溯源，陈旧包一眼可辨 */
declare const __GIT_SHA__: string;
