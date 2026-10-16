/** 单个本地 `codex app-server` 进程的有界 JSONL RPC 通道。 */
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CodexRpcId = string | number;
export interface CodexServerRequest {
  id: CodexRpcId;
  method: string;
  params: unknown;
}
export interface CodexNotification {
  method: string;
  params: unknown;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number | string, message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

/** 管道可能在多字节 UTF-8 字符中间分块，尾行也可能没有换行。 */
export class CodexJsonlReader {
  private readonly decoder = new StringDecoder("utf8");
  private rest = "";
  private ended = false;

  constructor(private readonly onLine: (line: string) => void, private readonly maxLineBytes = 8 * 1024 * 1024) {}

  write(chunk: Buffer | string): void {
    if (this.ended) return;
    this.rest += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain();
    if (Buffer.byteLength(this.rest) > this.maxLineBytes) throw new CodexRpcError("PROTOCOL_ERROR", "Codex RPC line is too large");
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.rest += this.decoder.end();
    this.drain();
    const last = this.rest;
    this.rest = "";
    if (Buffer.byteLength(last) > this.maxLineBytes) throw new CodexRpcError("PROTOCOL_ERROR", "Codex RPC line is too large");
    if (last.trim() !== "") this.onLine(last);
  }

  private drain(): void {
    let index = this.rest.indexOf("\n");
    while (index >= 0) {
      if (Buffer.byteLength(this.rest.slice(0, index)) > this.maxLineBytes) throw new CodexRpcError("PROTOCOL_ERROR", "Codex RPC line is too large");
      const line = this.rest.slice(0, index);
      this.rest = this.rest.slice(index + 1);
      if (line.trim() !== "") this.onLine(line);
      index = this.rest.indexOf("\n");
    }
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface PendingWrite {
  line: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onDrain?: () => void;
}

export interface CodexRpcOptions {
  requestTimeoutMs?: number;
  writeTimeoutMs?: number;
  onNotification?: (notification: CodexNotification) => void;
  onRequest?: (request: CodexServerRequest) => void;
  onFault?: (error: Error) => void;
}

export class CodexRpc {
  private readonly pending = new Map<CodexRpcId, PendingRequest>();
  private readonly writes: PendingWrite[] = [];
  private currentWrite: PendingWrite | null = null;
  private seq = 0;
  private failure: Error | null = null;
  private readonly reader: CodexJsonlReader;
  private readonly requestTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(private readonly child: ChildProcess, private readonly options: CodexRpcOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
    this.reader = new CodexJsonlReader((line) => this.receive(line));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (this.failure) return;
      try { this.reader.write(chunk); } catch (error) { this.fail(asError(error)); }
    });
    child.stdout?.on("end", () => {
      if (this.failure) return;
      try { this.reader.end(); } catch (error) { this.fail(asError(error)); }
    });
    // 进程收尾前始终保留错误监听：迟到的 EPIPE 不能变成未捕获异常。
    // stdin 正常关闭时仍允许 stdout 输出最后的应答；新写入会检测已关闭状态。
    child.stdin?.on("error", () => this.fail(new CodexRpcError("INPUT_CLOSED", "Codex process input failed")));
    child.stdout?.on("error", () => this.fail(new CodexRpcError("OUTPUT_CLOSED", "Codex process output failed")));
    child.on("error", () => this.fail(new CodexRpcError("PROCESS_ERROR", "Codex process could not start or failed")));
    child.on("close", () => {
      // 先读取无换行的尾行应答，再拒绝其余未完成请求。
      if (!this.failure) {
        try { this.reader.end(); } catch (error) { this.fail(asError(error)); }
      }
      this.fail(new CodexRpcError("PROCESS_CLOSED", "Codex process exited"));
    });
  }

  get pendingCount(): number { return this.pending.size; }
  get closed(): boolean { return this.failure !== null; }

  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `hub-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError("RPC_TIMEOUT", `Codex ${method} request timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch((error: unknown) => this.fail(asError(error)));
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: CodexRpcId, result: unknown): Promise<void> { return this.write({ id, result }); }

  respondError(id: CodexRpcId, code: number, message: string): Promise<void> {
    return this.write({ id, error: { code, message } });
  }

  dispose(reason: Error = new CodexRpcError("RPC_CLOSED", "Codex RPC connection closed")): void {
    this.fail(reason, false);
  }

  private write(row: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.writes.push({ line: `${JSON.stringify(row)}\n`, resolve, reject });
      this.pumpWrites();
    });
  }

  /** 串行写入；背压时同时等待回调和 drain，避免把“排入缓冲区”误作写入成功。 */
  private pumpWrites(): void {
    if (this.failure || this.currentWrite) return;
    const write = this.writes.shift();
    if (!write) return;
    this.currentWrite = write;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      this.fail(new CodexRpcError("INPUT_CLOSED", "Codex process input is unavailable"));
      return;
    }
    let callbackDone = false;
    let writeReturned = false;
    let drained = true;
    const finish = () => {
      if (!writeReturned || !callbackDone || !drained || this.currentWrite !== write || this.failure) return;
      this.clearWrite(write);
      this.currentWrite = null;
      write.resolve();
      this.pumpWrites();
    };
    write.timer = setTimeout(() => this.fail(new CodexRpcError("WRITE_TIMEOUT", "Codex process input timed out")), this.writeTimeoutMs);
    write.onDrain = () => { drained = true; finish(); };
    stdin.once("drain", write.onDrain);
    try {
      drained = stdin.write(write.line, (error?: Error | null) => {
        if (error) {
          this.fail(new CodexRpcError("INPUT_CLOSED", "Codex process input failed"));
          return;
        }
        callbackDone = true;
        finish();
      });
      writeReturned = true;
      finish();
    } catch {
      this.fail(new CodexRpcError("INPUT_CLOSED", "Codex process input failed"));
    }
  }

  private clearWrite(write: PendingWrite): void {
    if (write.timer) clearTimeout(write.timer);
    if (write.onDrain) this.child.stdin?.off("drain", write.onDrain);
  }

  private receive(line: string): void {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return; }
    if (!isRecord(row)) return;
    if (typeof row.method === "string") {
      if (isRpcId(row.id)) {
        try {
          if (this.options.onRequest) this.options.onRequest({ id: row.id, method: row.method, params: row.params });
          else void this.respondError(row.id, -32601, "Client does not support this server request").catch(() => undefined);
        } catch {
          void this.respondError(row.id, -32603, "Client could not handle this server request").catch(() => undefined);
        }
      } else {
        try { this.options.onNotification?.({ method: row.method, params: row.params }); } catch { /* 隔离上层回调异常 */ }
      }
      return;
    }
    if (!isRpcId(row.id)) return;
    const request = this.pending.get(row.id);
    if (!request) return;
    this.pending.delete(row.id);
    clearTimeout(request.timer);
    if (isRecord(row.error)) {
      request.reject(new CodexRpcError(
        typeof row.error.code === "number" ? row.error.code : "RPC_ERROR",
        typeof row.error.message === "string" ? row.error.message : "Codex RPC request failed",
      ));
    } else if (Object.hasOwn(row, "result")) request.resolve(row.result);
    else request.reject(new CodexRpcError("PROTOCOL_ERROR", "Codex RPC response has no result"));
  }

  private fail(error: Error, notify = true): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    const writes = this.currentWrite ? [this.currentWrite, ...this.writes] : [...this.writes];
    this.currentWrite = null;
    this.writes.length = 0;
    for (const write of writes) { this.clearWrite(write); write.reject(error); }
    if (notify) {
      try { this.options.onFault?.(error); } catch { /* 隔离上层回调异常 */ }
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isRpcId(value: unknown): value is CodexRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error("Codex RPC failed"); }
