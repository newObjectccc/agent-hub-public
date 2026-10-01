/**
 * w6-ux 浏览器验收用 stub server（只用于取证，不进运行时代码路径）：
 * - 服务 web/dist 静态文件
 * - 伪造 300 会话 / 单会话 120 条消息 + GET /api/sessions/:id 分页
 * - POST prompt 记录请求体（mode 取证）后延迟 2.5s 返回（截"发送中"loading）
 * - WS /ws/sessions/:id 推送 status=running（展示 steer 模式切换）
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// 路径全部相对本文件/仓库根解析（可用环境变量覆盖），不写死任何本机目录
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const require = createRequire(join(REPO_ROOT, "server", "package.json"));
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.STUB_PORT ?? 7799);
const WEB_ROOT = process.env.STUB_WEB_ROOT ?? join(REPO_ROOT, "web", "dist");
const EVIDENCE_DIR = process.env.STUB_EVIDENCE_DIR ?? join(HERE, "w6-ux-evidence");
mkdirSync(EVIDENCE_DIR, { recursive: true });

const now = Date.parse("2026-02-18T12:00:00.000Z");

// ---- 300 个会话 ----
const sessions = Array.from({ length: 300 }, (_, i) => {
  const n = i + 1;
  return {
    id: `sess-${String(n).padStart(3, "0")}`,
    name: n % 3 === 0 ? `pi-demo-KPI-${n}` : n % 3 === 1 ? `pi-tracing-${n}` : null,
    cwd: `/Users/demo/Workspace/project-${n % 7}`,
    updatedAt: new Date(now - i * 120_000).toISOString(),
    messageCount: 120,
    status: i < 3 ? "running" : "idle",
    lastUserMessage: `帮我检查第 ${n} 项任务的进度与风险`,
    lastAssistantMessage: `好的，我先梳理 project-${n % 7} 的现状再给出结论。`,
    sessionFile: `/Users/demo/.pi/agent/sessions/x/sess-${n}.jsonl`,
  };
});

// ---- 120 条消息 ----
const messages = Array.from({ length: 120 }, (_, i) => {
  const n = i + 1;
  const isUser = n % 2 === 1;
  return {
    id: `m${n}`,
    role: isUser ? "user" : "assistant",
    timestamp: now - (120 - n) * 60_000,
    text: isUser
      ? `【第 ${n} 条】帮我看看这个改动有没有回归风险？`
      : `【第 ${n} 条】已核对：构建与测试均通过，无回归。\n\n- 影响范围：\`web/src\`\n- 结论：可以合入`,
    toolCalls: [],
  };
});

function paginate(before, limit) {
  const lim = limit ?? 50;
  if (before) {
    const idx = messages.findIndex((m) => m.id === before);
    if (idx === -1) return tail(lim);
    const start = Math.max(0, idx - lim);
    const window = messages.slice(start, idx);
    return { messages: window, hasMore: start > 0, nextBefore: start > 0 && window.length ? window[0].id : null };
  }
  return tail(lim);
}

function tail(lim) {
  const start = Math.max(0, messages.length - lim);
  const window = messages.slice(start);
  return { messages: window, hasMore: start > 0, nextBefore: start > 0 && window.length ? window[0].id : null };
}

const clients = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const sendJson = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/sessions") return sendJson(200, { sessions });
  if (url.pathname === "/api/kpi") {
    return sendJson(200, {
      cards: [{ id: "demo", title: "Demo KPI", value: "98.2%", trend: "up", delta: "+0.4%", updatedAt: new Date(now).toISOString(), link: null, error: null }],
    });
  }
  if (url.pathname === "/api/system") {
    return sendJson(200, {
      platform: "darwin",
      pi: { available: true, version: "0.87.1" },
      tmux: { available: true, version: "3.4" },
      ttyd: { available: false, version: null },
      tailscale: { available: true, loggedIn: true, hostname: "demo-mac" },
      sessionDir: "/Users/demo/.pi/agent/sessions",
      workspaceRoot: "/Users/demo/Workspace",
    });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    const id = decodeURIComponent(sessionMatch[1]);
    const session = sessions.find((s) => s.id === id);
    if (!session) return sendJson(404, { error: { code: "SESSION_NOT_FOUND", message: "会话不存在" } });
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    const before = url.searchParams.get("before") ?? undefined;
    const page = url.searchParams.has("limit") || before ? paginate(before, limit) : { messages, hasMore: false, nextBefore: null };
    return sendJson(200, { session, ...page });
  }

  const promptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
  if (promptMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      appendFileSync(join(EVIDENCE_DIR, "prompt-requests.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...parsed })}\n`);
      // 延迟 2.5s 返回：截"发送中"loading 态
      setTimeout(() => {
        sendJson(202, { accepted: true, mode: parsed.mode === undefined ? "prompt" : parsed.mode });
        // 回一条消息（模拟 message_end 权威落盘）
        const echo = {
          id: `echo-${Date.now()}`,
          role: "assistant",
          timestamp: Date.now(),
          text: `（stub 回声，mode=${parsed.mode ?? "prompt"}）已收到：${String(parsed.text ?? "").slice(0, 40)}`,
          toolCalls: [],
        };
        for (const ws of clients) ws.send(JSON.stringify({ type: "message_end", message: echo }));
      }, 2500);
    });
    return;
  }

  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/abort$/) && req.method === "POST") {
    return sendJson(200, { aborted: true });
  }

  // 静态文件（SPA fallback → index.html）
  let file = normalize(join(WEB_ROOT, url.pathname));
  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(WEB_ROOT, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server }); // 任意 /ws 路径（取证 stub）
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "session", id: "demo", cwd: "/Users/demo/Workspace/project-0" }));
  ws.send(JSON.stringify({ type: "status", status: "running" }));
  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch {
      /* ignore */
    }
  });
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub server: http://127.0.0.1:${PORT}`);
});
