/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 关于/版本号与 web/package.json 同步（构建期注入，不手写防漂移）
const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

// 开发时把 /api 与 /ws 转发到 agent-hub server（默认 127.0.0.1:7700）
const serverTarget = process.env.AGENT_HUB_SERVER ?? "http://127.0.0.1:7700";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: serverTarget, changeOrigin: true },
      "/ws": { target: serverTarget, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
