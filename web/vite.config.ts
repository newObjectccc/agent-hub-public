/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 开发时把 /api 与 /ws 转发到 agent-hub server（默认 127.0.0.1:7700）
const serverTarget = process.env.AGENT_HUB_SERVER ?? "http://127.0.0.1:7700";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
