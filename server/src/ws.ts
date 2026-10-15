/**
 * WS /ws/sessions/:id：订阅 pi 会话事件流（docs/API_CONTRACT.md §6）。
 * 连接即订阅；重连后客户端走 GET /api/sessions/:id 全量对账（不做增量恢复）。
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { loadClaudeSessionMessages } from "./adapters/claude-transcript.js";
import { loadCodexSessionMessages } from "./adapters/codex-rollout.js";
import { ErrorCodes } from "./errors.js";
import type { PromptResult } from "./sessions/hub.js";
import type { MessageLoader, SessionTailManager } from "./sessions/tail.js";
import { UPGRADE_HANDLED_MARK } from "./terminal.js";
import type { ServerEvent, SessionListItem } from "./types.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;
const WS_EVENTS_PATH = "/ws/events";

/** 连接建立期 pending 队列上限（P2-5）：findSession 解析完成前的消息堆积防护，超出丢弃最旧 */
export const WS_PENDING_MAX = 100;

/** WS upgrade 鉴权配置（与 routes.ts HTTP Bearer 鉴权同口径） */
export interface WsAuthConfig {
  enabled: boolean;
  token: string;
}

/**
 * WsHub.attach 挂载选项（修复：WS 鉴权未接线）：
 * auth 必填——此前第 5 参可选导致生产装配漏传，auth.enabled 时 WS 完全绕过鉴权；
 * 现在漏传 = 编译错误，未启用鉴权也要显式传 { enabled: false, token: "" }。
 */
export interface WsAttachOptions {
  /** 非本进程会话的文件 tail 实时推送（可选） */
  tailManager?: SessionTailManager;
  /** prompt 冲突保护（attach 接管期）+ 锁屏门禁（lockToken） */
  promptGuard?: (sessionId: string, lockToken?: string) => { code: string; message: string } | null;
  /**
   * WS abort 门禁 + 分发（修复：abort 绕过 promptGuard，锁屏/接管期可中止 turn）——镜像 HTTP
   * /api/sessions/:id/abort 语义：返回错误对象 = 拒绝并回 error 帧（对齐 prompt 分支回执形状）；
   * null = 已执行中止。不复用 promptGuard：其含 ATTACH_ACTIVE 拒绝，而 abort 在接管期合法且必要。
   * 可选：未装配 = 裸 hub.abort（测试直连 attach 兜底）；生产经 attachSessionWs 装配。
   */
  abortHandler?: (sessionId: string, lockToken?: string) => Promise<{ code: string; message: string } | null>;
  /**
   * hub WS 路径（/ws/events、/ws/sessions/*）Origin 跨站闸（修复：WS upgrade 无 Origin 校验，
   * 默认配置下任意网页可跨站劫持会话）：有 Origin 头（浏览器必带）时必须通过，否则 403 断连；
   * 无 Origin 头（非浏览器客户端：node ws 库 / curl / 自动化）不在此闸，维持 token 判定。
   * protocol 为连接协议（https 连接传 "https"），供反代感知的同源判定使用。
   * 可选：未装配 = 不校验（测试直连 attach）；生产经 attachSessionWs 从 config 派生装配（与 HTTP CORS 闸同源）。
   */
  isAllowedOrigin?: (req: Pick<IncomingMessage, "headers" | "url">, protocol: string) => boolean;
  /** upgrade 鉴权（config.auth 派生；必填，见上） */
  auth: WsAuthConfig;
}

/**
 * 提取 upgrade 请求的 token（三种通道，与 HTTP 鉴权同口径）：
 * 1. `Authorization: Bearer <token>`（非浏览器客户端）
 * 2. `Sec-WebSocket-Protocol: bearer, <token>` / `bearer.<token>`（浏览器 WS 不能自定义头）
 * 3. query `?token=<token>`（最后手段）
 */
export function extractWsToken(req: Pick<IncomingMessage, "headers" | "url">): string | null {
  const authz = req.headers.authorization;
  if (typeof authz === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1].trim();
  }
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    const parts = proto
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      const dot = p.indexOf(".");
      if (dot > 0) {
        const scheme = p.slice(0, dot).toLowerCase();
        if (scheme === "bearer" || scheme === "token" || scheme === "access_token") return p.slice(dot + 1);
      }
      const lower = p.toLowerCase();
      if ((lower === "bearer" || lower === "token" || lower === "access_token") && i + 1 < parts.length) {
        return parts[i + 1];
      }
    }
  }
  try {
    const q = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
    if (q !== null && q !== "") return q;
  } catch {
    /* 非法 URL：无 token */
  }
  return null;
}

/**
 * 解锁令牌（app lock，与 auth token 独立）：header `x-app-lock-token`（非浏览器客户端）
 * / 子协议 `lock-token.<t>`（浏览器 WS 不带自定义头；子协议不进 URL/日志）/ query `lockToken` 兼容。
 */
export function extractWsLockToken(req: Pick<IncomingMessage, "headers" | "url">): string | undefined {
  const header = req.headers["x-app-lock-token"];
  if (typeof header === "string" && header !== "") return header.trim();
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    for (const part of proto.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      const dot = part.indexOf(".");
      if (dot > 0 && part.slice(0, dot).toLowerCase().replace(/_/g, "-") === "lock-token") return part.slice(dot + 1);
    }
  }
  try {
    const q = new URL(req.url ?? "", "http://localhost").searchParams.get("lockToken");
    if (q !== null && q !== "") return q;
  } catch {
    /* 非法 URL：无 token */
  }
  return undefined;
}

function safeTokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * tail 解析器按 source 注入：pi 走默认 loader（session-format v3），
 * claude/codex 各用自己的文件格式解析（只认新消息即可）。
 */
function tailLoaderFor(source: SessionListItem["source"]): MessageLoader | undefined {
  if (source === "claude") return loadClaudeSessionMessages;
  if (source === "codex") return loadCodexSessionMessages;
  return undefined;
}

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
  /** 子代理会话增量发现间隔（默认 10s；测试可注入短值） */
  childScanMs = 10_000;
  /** prompt 冲突保护（E3：attach 接管期间拒绝 parallel 发送，防双写）+ 锁屏门禁（lockToken） */
  private promptGuard: ((sessionId: string, lockToken?: string) => { code: string; message: string } | null) | null = null;
  /** WS abort 门禁 + 分发（镜像 HTTP /abort：锁屏拒绝 + driver.abortTurn/hub.abort 分发） */
  private abortHandler: ((sessionId: string, lockToken?: string) => Promise<{ code: string; message: string } | null>) | null = null;
  /** hub WS 路径 Origin 跨站闸（与 HTTP CORS 闸同源同逻辑；无 Origin 头不校验） */
  private isAllowedOrigin: ((req: Pick<IncomingMessage, "headers" | "url">, protocol: string) => boolean) | null = null;
  /** upgrade 鉴权（config.auth.enabled 时校验 token，无/错 token 直接断连） */
  private auth: WsAuthConfig | null = null;

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

  /**
   * 挂到 HTTP server 的 upgrade 事件。
   * opts.auth 必填（修复：WS 鉴权未接线——可选参数被漏传时 auth 恒 null，auth.enabled 下 WS 绕过鉴权）：
   * 漏传直接编译错误；未启用鉴权的调用点显式传 { enabled: false, token: "" }。
   */
  attach(server: HttpServer, hub: WsSessionHub, opts: WsAttachOptions): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    this.tails = opts.tailManager ?? null;
    this.promptGuard = opts.promptGuard ?? null;
    this.abortHandler = opts.abortHandler ?? null;
    this.isAllowedOrigin = opts.isAllowedOrigin ?? null;
    this.auth = opts.auth;

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // 鉴权在 upgrade 阶段完成（与 HTTP Bearer 同口径）：无/错 token 直接断连，不进 handleUpgrade
      if (!this.authorizeUpgrade(req, socket)) return;
      const url = (req.url ?? "").split("?")[0];
      // hub WS 路径才做 Origin 跨站闸（修复：WS upgrade 无 Origin 校验，默认配置任意网页可跨站劫持会话）。
      // 只闸 /ws/events 与 /ws/sessions/*：/terminal/ws 等非 hub 路径不碰（否则 ttyd 反代通道被误杀）；
      // 鉴权与 Origin 是 AND 关系，两道都过才进 handleUpgrade
      const isHubPath = url === WS_EVENTS_PATH || WS_PATH_RE.test(url);
      if (isHubPath && !this.authorizeOrigin(req, socket)) return;
      // 全局事件通道：会话列表变更通知（presence）
      if (url === WS_EVENTS_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleGlobalConnection(ws);
        });
        return;
      }
      const match = WS_PATH_RE.exec(url);
      if (!match) {
        // 非 hub WS 路径：若已被其他 upgrade 处理器接管（如 /terminal/ws ttyd 反代，
        // 见 terminal.ts 的 UPGRADE_HANDLED_MARK），不销毁；否则拒绝未知 upgrade
        if ((req as unknown as Record<string, unknown>)[UPGRADE_HANDLED_MARK] !== true) {
          socket.destroy();
        }
        return;
      }
      // 畸形百分号编码（如 %ZZ）防护：decodeURIComponent 抛 URIError 会从 upgrade
      // 监听器冒成 uncaughtException 拖垮整个 hub（pre-auth DoS）——拒绝该连接，进程不受影响
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]);
      } catch {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const lockToken = extractWsLockToken(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, sessionId, hub, lockToken);
      });
    });
  }

  /**
   * upgrade 鉴权：config.auth.enabled 且 token 非空时必须携带合法 token
   * （Authorization / Sec-WebSocket-Protocol / ?token=，与 routes.ts HTTP 鉴权同口径）。
   * 失败直接 401 + 断连（不进 WebSocket 握手）。
   */
  private authorizeUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const auth = this.auth;
    if (!auth || !auth.enabled || auth.token === "") return true;
    const provided = extractWsToken(req);
    if (provided !== null && safeTokenEquals(provided, auth.token)) return true;
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return false;
  }

  /**
   * Origin 同源闸（修复：WS upgrade 无 Origin 校验，默认配置下任意网页可跨站劫持会话——
   * 恶意页 new WebSocket 即可实时读全部会话、经 /ws/sessions/:id 发 prompt）：
   * 有 Origin 头（浏览器必带）→ 必须通过与 HTTP CORS 闸同口径的判定（isAllowedOrigin，
   * 由 index.ts attachSessionWs 用 config 派生，复用 crossOriginAllowed）；
   * 无 Origin 头（非浏览器客户端：node ws 库 / curl / 自动化）→ 不校验，维持 token 判定（不破坏自动化）。
   * 失败直接 403 + 断连（对齐 authorizeUpgrade 的 socket.write + destroy 风格）。
   * 只应由 hub WS 路径（/ws/events、/ws/sessions/*）调用；/terminal/ws 等非 hub 路径不受此闸。
   */
  private authorizeOrigin(req: IncomingMessage, socket: Duplex): boolean {
    const check = this.isAllowedOrigin;
    if (!check) return true;
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "") return true;
    const protocol = (socket as Duplex & { encrypted?: boolean }).encrypted === true ? "https" : "http";
    if (check(req, protocol)) return true;
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return false;
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
  private handleConnection(socket: WebSocket, sessionId: string, hub: WsSessionHub, lockToken?: string): void {
    const pending: string[] = [];
    let ready = false;
    let acquired = false;
    let closed = false;
    /** 父会话订阅期间顺带 tail 的子代理会话（反馈轮 3 #4）：Set 单一事实源，acquire/release 严格配对，
     * 子会话消失时同步移除后再 release，cleanup 不会二次 release 误减其它连接同 id tail 的 ref */
    const childTails = new Set<string>();
    const cleanupFns: Array<() => void> = [];
    const process = (text: string): void => {
      void this.handleClientMessage(socket, sessionId, hub, text, lockToken);
    };

    const cleanup = (): void => {
      closed = true;
      for (const fn of cleanupFns.splice(0)) fn();
      this.remove(sessionId, socket);
      if (acquired) {
        acquired = false;
        this.tails?.release(sessionId);
      }
      for (const childId of childTails) {
        this.tails?.release(childId);
      }
      childTails.clear();
    };

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = raw.toString();
      if (ready) {
        process(text);
      } else {
        // P2-5：握手前消息队列限容（100 条/连接），超出丢最旧——防建立期消息风暴把
        // pending 数组堆到无上界（丢最旧保最新，连接保持可用）
        if (pending.length >= WS_PENDING_MAX) pending.shift();
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
      // 连接建立期已断开（close 先于 findSession 返回）：不再注册，防死 socket 永驻 clients Map
      if (closed) return;

      this.add(sessionId, socket);
      // 契约：连接后首条握手确认
      this.send(socket, { type: "session", id: session.id, cwd: session.cwd });

      // 非本进程会话：启动文件 tail 实时推送（本进程会话由 SDK/spawn 事件流推送，避免重复）。
      // 解析器按 source 注入（tailLoaderFor）：pi 用 session-format v3，claude/codex 各自格式
      if (this.tails && !hub.isLive(sessionId) && socket.readyState === WebSocket.OPEN) {
        const loader = tailLoaderFor(session.source);
        this.tails.acquire(sessionId, session.sessionFile, loader);
        acquired = true;
      }

      // 子代理会话 tail（反馈轮 3 #4）：父会话订阅期间顺带 tail 全部子代理会话，
      // 其事件经 emit → SubAgentRouter 按 parentSessionId 路由回父通道（活动面板实时更新）。
      // 异步解析完成前连接已关：不 acquire（或立即 release），防 tail 泄漏。
      const syncChildren = (): void => {
        if (!this.tails || closed || !hub.listChildren || socket.readyState !== WebSocket.OPEN) return;
        void hub
          .listChildren(sessionId)
          .then((children) => {
            if (closed || socket.readyState !== WebSocket.OPEN) return;
            const seen = new Set<string>();
            for (const child of children) {
              seen.add(child.id);
              if (childTails.has(child.id) || hub.isLive(child.id)) continue;
              const childLoader = tailLoaderFor(child.source);
              this.tails?.acquire(child.id, child.sessionFile, childLoader);
              childTails.add(child.id);
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
            // 消失的子会话：同步移除追踪并 release（每连接 acquire/release 严格配对，不误减其它连接的 ref）
            for (const id of [...childTails]) {
              if (!seen.has(id)) {
                childTails.delete(id);
                this.tails?.release(id);
              }
            }
          })
          .catch(() => undefined);
      };
      if (this.tails && hub.listChildren) {
        syncChildren();
        // 增量发现：订阅期间新派生的子代理（面板开着不刷新也能看到新卡片）
        const childScan = setInterval(syncChildren, this.childScanMs); // 发现上界（轻量血缘扫描毫秒级；测试可注入短值）
        childScan.unref?.();
        // cleanup 可能已执行过（cleanupFns 被 splice 清空，后 push 的回调永不触发）：
        // closed 时立即 clear，防 interval 泄漏持续扫盘
        if (closed) {
          clearInterval(childScan);
        } else {
          cleanupFns.push(() => clearInterval(childScan));
        }
      }

      ready = true;
      const queued = pending.splice(0);
      for (const text of queued) process(text);
    })();
  }

  private async handleClientMessage(socket: WebSocket, sessionId: string, hub: WsSessionHub, raw: string, lockToken?: string): Promise<void> {
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
        // WS abort 门禁 + 分发（修复：abort 绕过 promptGuard，锁屏/接管期可中止 turn）：
        // 走 abortHandler（镜像 HTTP /abort：锁屏门禁 → driver.abortTurn/hub.abort 分发），
        // 拒绝时回 error 帧（对齐 prompt 分支回执形状）。未装配 = 裸 hub.abort（测试直连 attach 兜底）
        if (this.abortHandler) {
          const blocked = await this.abortHandler(sessionId, lockToken);
          if (blocked) this.send(socket, { type: "error", code: blocked.code, message: blocked.message });
          return;
        }
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
          const blocked = this.promptGuard?.(sessionId, lockToken) ?? null;
          if (blocked) {
            this.send(socket, { type: "error", code: blocked.code, message: blocked.message });
            return;
          }
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
