/**
 * WS /ws/sessions/:id：订阅 pi 会话事件流（docs/API_CONTRACT.md §4）。
 * 连接即订阅；重连后客户端走 GET /api/sessions/:id 全量对账（不做增量恢复）。
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { ErrorCodes } from "./errors.js";
import type { SessionHub } from "./sessions/hub.js";
import type { SessionTailManager } from "./sessions/tail.js";
import type { ServerEvent } from "./types.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;

interface ClientMessage {
  type?: unknown;
  text?: unknown;
  mode?: unknown;
}

export class WsHub {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private wss: WebSocketServer | null = null;
  private tails: SessionTailManager | null = null;;

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

  /** 挂到 HTTP server 的 upgrade 事件；tailManager 可选，为非本进程会话提供实时文件 tail */
  attach(server: HttpServer, hub: SessionHub, tailManager?: SessionTailManager): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    this.tails = tailManager ?? null;

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      const match = WS_PATH_RE.exec(url.split("?")[0]);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, sessionId, hub);
      });
    });
  }

  /** 关闭全部连接与 WSS。进程退出前调用，否则 app.close() 会被在线 WS 连接挂住不返回 */
  closeAll(): void {
    this.tails?.stopAll();
    for (const set of this.clients.values()) {
      for (const socket of set) {
        socket.terminate();
      }
    }
    this.clients.clear();
    const wss = this.wss;
    this.wss = null;
    if (wss) wss.close();
  }

  /**
   * 同步注册消息监听；findSession 解析完成前到达的消息进 pending 队列，
   * 握手后统一消费。修复“连接即发的消息静默丢失”竞态。
   */
  private handleConnection(socket: WebSocket, sessionId: string, hub: SessionHub): void {
    const pending: string[] = [];
    let ready = false;
    let acquired = false;
    const process = (text: string): void => {
      void this.handleClientMessage(socket, sessionId, hub, text);
    };

    const cleanup = (): void => {
      this.remove(sessionId, socket);
      if (acquired) {
        acquired = false;
        this.tails?.release(sessionId);
      }
    };

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = raw.toString();
      if (ready) {
        process(text);
      } else {
        pending.push(text);
      }
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    void (async () => {
      const session = await hub.findSession(sessionId);
      if (!session) {
        this.send(socket, { type: "error", code: ErrorCodes.SESSION_NOT_FOUND, message: `会话不存在: ${sessionId}` });
        socket.close(1008, ErrorCodes.SESSION_NOT_FOUND);
        return;
      }

      this.add(sessionId, socket);
      // 契约：连接后首条握手确认
      this.send(socket, { type: "session", id: session.id, cwd: session.cwd });

      // 非本进程会话：启动文件 tail 实时推送（本进程会话由 SDK 事件流推送，避免重复）
      if (this.tails && !hub.isLive(sessionId) && socket.readyState === WebSocket.OPEN) {
        this.tails.acquire(sessionId, session.sessionFile);
        acquired = true;
      }

      ready = true;
      const queued = pending.splice(0);
      for (const text of queued) process(text);
    })();
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
