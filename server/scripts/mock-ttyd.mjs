#!/usr/bin/env node
/**
 * mock ttyd（F2 验证用）：模拟 ttyd CLI 子集（--port/--interface/--writable/--credential/
 * --client-option + shell 参数），用于本机未安装 ttyd 时的完整链路验证（不冒充生产终端）。
 *
 * - 启动日志与真实 ttyd 同形：`Listening on '127.0.0.1:<port>'`（server 就绪探测读取它）
 * - GET / 返回仿终端页：用 `new WebSocket("ws://" + location.host + "/ws")` 连接，
 *   依赖 server 反代 shim 把 /ws 改写到 /terminal/ws（验证 shim 注入真实生效）
 * - GET /assets/main.js：验证绝对资源路径改写（页面引用 /assets/main.js）
 * - Basic 认证：校验 --credential（验证 server 反代注入随机凭证）
 * - WS /ws：echo + 欢迎行（验证 upgrade 字节流管道）
 *
 * 用法（PATH 里放一个名为 ttyd 的可执行指向本文件）：
 *   ttyd --port 1234 --interface 127.0.0.1 --writable --credential hub:xxx --client-option fontSize=14 /bin/zsh
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const argv = process.argv.slice(2);
// 版本探测（server 的 which/探测链会调 `ttyd --version`）：直接应答退出，不拉起服务
if (argv.includes("--version") || argv.includes("-v")) {
  console.log("ttyd version 1.7.7 (mock)");
  process.exit(0);
}
const opts = { port: 7681, interface: "0.0.0.0", credential: null, writable: false };
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--port") opts.port = Number.parseInt(argv[++i], 10);
  else if (a === "--interface") opts.interface = argv[++i];
  else if (a === "--credential") opts.credential = argv[++i];
  else if (a === "--writable") opts.writable = true;
  else if (a === "--client-option") i += 1;
  else rest.push(a);
}

const expectedAuth = opts.credential ? `Basic ${Buffer.from(opts.credential).toString("base64")}` : null;

const PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>mock ttyd</title>
<style>
  body { margin: 0; background: #10151c; color: #d7e0ea; font: 14px/1.5 ui-monospace, monospace; }
  #term { padding: 12px; white-space: pre-wrap; min-height: 100vh; box-sizing: border-box; }
  .ok { color: #7ee787; } .dim { color: #8b98a5; }
</style></head>
<body><div id="term"></div>
<script src="/assets/main.js"></script>
<script>
  // 与真实 ttyd 客户端同构：ws 路径写死 /ws（验证 server shim 改写到 /terminal/ws）
  var term = document.getElementById("term");
  function line(text, cls) {
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    term.appendChild(div);
  }
  line("[mock ttyd] terminal page loaded", "dim");
  var ws = new WebSocket("ws://" + location.host + "/ws");
  ws.onopen = function () { line("[mock ttyd] websocket connected (shim rewrite OK)", "ok"); };
  ws.onmessage = function (ev) { line("[mock ttyd] " + ev.data); };
  ws.onerror = function () { line("[mock ttyd] websocket error", "dim"); };
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (expectedAuth && req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="ttyd"' }).end("401");
    return;
  }
  const path = (req.url ?? "").split("?")[0];
  if (path === "/" || path === "/terminal/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (path === "/assets/main.js") {
    res
      .writeHead(200, { "content-type": "application/javascript" })
      .end('document.title = "mock ttyd (asset rewritten)";');
    return;
  }
  res.writeHead(404).end("mock ttyd: not found");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (expectedAuth && req.headers.authorization !== expectedAuth) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send("welcome to mock ttyd (shell: " + rest.join(" ") + ")");
    ws.on("message", (raw) => ws.send("echo: " + String(raw)));
  });
});

server.listen(opts.port, opts.interface, () => {
  // 与真实 ttyd 相同的就绪日志格式（server 端 parseTtydListenPort 解析它）
  console.log(`Listening on '${opts.interface}:${opts.port}'`);
});
