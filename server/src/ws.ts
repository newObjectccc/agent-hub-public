/**
 * WS /ws/sessions/:id：订阅 pi 会话事件流（docs/API_CONTRACT.md §4）。
 * 连接即订阅；重连后客户端走 GET /api/sessions/:id 全量对账（不做增量恢复）。
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { ErrorCodes } from "./errors.js";
import type { SessionHub } from "./sessions/hub.js";
import type { ServerEvent } from "./types.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;

interface ClientMessage {
  type?: unknown;
  text?: unknown;
  mode?: unknown;
}

export class WsHub {
  private readonly clients = new Map<string, Set<WebSocket>>();

  /** hub 广播出口（构造 SessionHub 时注入） */
  broadcast(sessionId: string, event: ServerEvent): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private add(sessionId: string, socket: WebSocket): void {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    set.add(socket);
  }

  private remove(sessionId: string, socket: WebSocket): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.clients.delete(sessionId);
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  /** 挂到 HTTP server 的 upgrade 事件 */
  attach(server: HttpServer, hub: SessionHub): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      const match = WS_PATH_RE.exec(url.split("?")[0]);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.handleConnection(ws, sessionId, hub);
      });
    });
  }

  private async handleConnection(socket: WebSocket, sessionId: string, hub: SessionHub): Promise<void> {
    const session = await hub.findSession(sessionId);
    if (!session) {
      this.send(socket, { type: "error", code: ErrorCodes.SESSION_NOT_FOUND, message: `会话不存在: ${sessionId}` });
      socket.close(1008, ErrorCodes.SESSION_NOT_FOUND);
      return;
    }

    this.add(sessionId, socket);
    // 契约：连接后首条握手确认
    this.send(socket, { type: "session", id: session.id, cwd: session.cwd });

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      void this.handleClientMessage(socket, sessionId, hub, raw.toString());
    });
    socket.on("close", () => this.remove(sessionId, socket));
    socket.on("error", () => this.remove(sessionId, socket));
  }

  private async handleClientMessage(socket: WebSocket, sessionId: string, hub: SessionHub, raw: string): Promise<void> {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, { type: "error", code: ErrorCodes.INVALID_MESSAGE, message: "消息不是合法 JSON" });
      return;
    }

    switch (parsed.type) {
      case "ping": {
        this.send(socket, { type: "pong" });
        return;
      }
      case "abort": {
        try {
          await hub.abort(sessionId);
        } catch (err) {
          this.send(socket, {
            type: "error",
            code: ErrorCodes.PROMPT_FAILED,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "prompt": {
        try {
          const result = await hub.prompt(sessionId, parsed.text, parsed.mode);
          if (result.busy) {
            this.send(socket, {
              type: "error",
              code: ErrorCodes.SESSION_BUSY,
              message: "会话正忙：请省略 mode 之外使用 steer/followUp，或先 abort",
            });
          }
        } catch (err) {
          this.send(socket, {
            type: "error",
            code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : ErrorCodes.PROMPT_FAILED,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      default: {
        this.send(socket, {
          type: "error",
          code: ErrorCodes.INVALID_MESSAGE,
          message: `未知消息 type: ${String(parsed.type)}`,
        });
      }
    }
  }
}
