/**
 * WS /ws/sessions/:id：订阅 pi 会话事件流（docs/API_CONTRACT.md §6）。
 * 连接即订阅；重连后客户端走 GET /api/sessions/:id 全量对账（不做增量恢复）。
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { loadClaudeSessionMessages } from "./adapters/claude-transcript.js";
import { ErrorCodes } from "./errors.js";
import type { PromptResult } from "./sessions/hub.js";
import type { SessionTailManager } from "./sessions/tail.js";
import type { ServerEvent, SessionListItem } from "./types.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;
const WS_EVENTS_PATH = "/ws/events";

/** WS 层对 hub 的最小结构依赖（SessionHub / SessionRegistry 都满足） */
export interface WsSessionHub {
  isLive(id: string): boolean;
  findSession(id: string): Promise<SessionListItem | null>;
  /** 子代理会话列表（pi-subagents 派生，反馈轮 3 #4；可选，fake hub 可不实现） */
  listChildren?(parentId: string): Promise<SessionListItem[]>;
  prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult>;
  abort(id: string): Promise<void>;
}

interface ClientMessage {
  type?: unknown;
  text?: unknown;
  mode?: unknown;
}

export class WsHub {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly globalClients = new Set<WebSocket>();
  private wss: WebSocketServer | null = null;
  private tails: SessionTailManager | null = null;

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

  /** 全局事件广播（/ws/events 订阅者）：会话列表变更通知 */
  broadcastGlobal(event: { type: string; [key: string]: unknown }): void {
    const payload = JSON.stringify(event);
    for (const socket of this.globalClients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  /** 挂到 HTTP server 的 upgrade 事件；tailManager 可选，为非本进程会话提供实时文件 tail */
  attach(server: HttpServer, hub: WsSessionHub, tailManager?: SessionTailManager): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    this.tails = tailManager ?? null;

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = (req.url ?? "").split("?")[0];
      // 全局事件通道：会话列表变更通知（presence）
      if (url === WS_EVENTS_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleGlobalConnection(ws);
        });
        return;
      }
      const match = WS_PATH_RE.exec(url);
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

  private handleGlobalConnection(socket: WebSocket): void {
    this.globalClients.add(socket);
    const cleanup = (): void => {
      this.globalClients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { type?: string };
        if (parsed.type === "ping") this.send(socket, { type: "pong" });
      } catch {
        this.send(socket, { type: "error", code: ErrorCodes.INVALID_MESSAGE, message: "消息不是合法 JSON" });
      }
    });
    // 握手确认
    this.send(socket, { type: "session", id: "events", cwd: "" });
  }

  /** 关闭全部连接与 WSS。进程退出前调用，否则 app.close() 会被在线 WS 连接挂住不返回 */
  closeAll(): void {
    this.tails?.stopAll();
    for (const socket of this.globalClients) {
      socket.terminate();
    }
    this.globalClients.clear();
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
  private handleConnection(socket: WebSocket, sessionId: string, hub: WsSessionHub): void {
    const pending: string[] = [];
    let ready = false;
    let acquired = false;
    let closed = false;
    /** 父会话订阅期间顺带 tail 的子代理会话（反馈轮 3 #4，cleanup 时释放） */
    const childTails: string[] = [];
    const cleanupFns: Array<() => void> = [];
    const process = (text: string): void => {
      void this.handleClientMessage(socket, sessionId, hub, text);
    };

    const cleanup = (): void => {
      closed = true;
      for (const fn of cleanupFns.splice(0)) fn();
      this.remove(sessionId, socket);
      if (acquired) {
        acquired = false;
        this.tails?.release(sessionId);
      }
      for (const childId of childTails.splice(0)) {
        this.tails?.release(childId);
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

      // 非本进程会话：启动文件 tail 实时推送（本进程会话由 SDK/spawn 事件流推送，避免重复）。
      // 解析器按 source 注入：pi 用 session-format v3，claude 用 transcript 格式（只认新消息即可）
      if (this.tails && !hub.isLive(sessionId) && socket.readyState === WebSocket.OPEN) {
        const loader = session.source === "claude" ? loadClaudeSessionMessages : undefined;
        this.tails.acquire(sessionId, session.sessionFile, loader);
        acquired = true;
      }

      // 子代理会话 tail（反馈轮 3 #4）：父会话订阅期间顺带 tail 全部子代理会话，
      // 其事件经 emit → SubAgentRouter 按 parentSessionId 路由回父通道（活动面板实时更新）。
      // 异步解析完成前连接已关：不 acquire（或立即 release），防 tail 泄漏。
      const childSet = new Set<string>();
      const syncChildren = (): void => {
        if (!this.tails || closed || !hub.listChildren || socket.readyState !== WebSocket.OPEN) return;
        void hub
          .listChildren(sessionId)
          .then((children) => {
            if (closed || socket.readyState !== WebSocket.OPEN) return;
            const seen = new Set<string>();
            for (const child of children) {
              seen.add(child.id);
              if (childSet.has(child.id) || hub.isLive(child.id)) continue;
              const childLoader = child.source === "claude" ? loadClaudeSessionMessages : undefined;
              this.tails?.acquire(child.id, child.sessionFile, childLoader);
              childSet.add(child.id);
              childTails.push(child.id);
              // 发现即推：静态子会话文件零 tail 事件，主动广播一条活动卡（面板 ≤10s 必现）
              this.broadcast(sessionId, {
                type: "subagent_activity",
                sessionId: child.id,
                parentSessionId: sessionId,
                activity: {
                  sessionId: child.id,
                  name: child.name ?? child.id,
                  status: "idle",
                  done: false,
                  updatedAt: Date.now(),
                },
              } as never);
            }
            // 消失的子会话 release（防 tail 泄漏）
            for (const id of [...childSet]) {
              if (!seen.has(id)) {
                childSet.delete(id);
                this.tails?.release(id);
              }
            }
          })
          .catch(() => undefined);
      };
      if (this.tails && hub.listChildren) {
        syncChildren();
        // 增量发现：订阅期间新派生的子代理（面板开着不刷新也能看到新卡片）
        const childScan = setInterval(syncChildren, 10_000); // 发现上界 ≤10s（轻量血缘扫描毫秒级）
        childScan.unref?.();
        cleanupFns.push(() => clearInterval(childScan));
      }

      ready = true;
      const queued = pending.splice(0);
      for (const text of queued) process(text);
    })();
  }

  private async handleClientMessage(socket: WebSocket, sessionId: string, hub: WsSessionHub, raw: string): Promise<void> {
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
