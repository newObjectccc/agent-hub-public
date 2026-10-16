import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CodexJsonlReader, CodexRpc, CodexRpcError } from "../adapters/codex-rpc.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  rows: Record<string, unknown>[] = [];
  stdin: Writable = new Writable({ write: (chunk, _encoding, callback) => { this.rows.push(JSON.parse(String(chunk))); callback(); } });
  get process(): ChildProcess { return this as unknown as ChildProcess; }
  result(id: unknown, result: unknown): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Codex JSONL transport", () => {
  it("preserves split UTF-8 and the unterminated last line", () => {
    const lines: string[] = [];
    const reader = new CodexJsonlReader((line) => lines.push(line));
    const data = Buffer.from('{"text":"你好😀"}\n{"tail":true}');
    for (const byte of data) reader.write(Buffer.from([byte]));
    reader.end();
    reader.end();
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ text: "你好😀" }, { tail: true }]);
  });

  it("rejects oversized lines instead of retaining an unbounded buffer", () => {
    const reader = new CodexJsonlReader(() => undefined, 5);
    assert.throws(() => reader.write("123456"), /too large/);
  });

  it("matches response IDs and reads a final response before close", async () => {
    const child = new FakeChild();
    const rpc = new CodexRpc(child.process);
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    await tick();
    child.result(child.rows[1].id, "second");
    child.stdout.write(JSON.stringify({ id: child.rows[0].id, result: "first" }));
    child.emit("close", 0);
    assert.deepEqual(await Promise.all([a, b]), ["first", "second"]);
    assert.equal(rpc.pendingCount, 0);
    child.stdin.emit("error", new Error("late EPIPE"));
  });

  it("flushes the last stdout line even if stdin has already closed normally", async () => {
    const child = new FakeChild();
    const rpc = new CodexRpc(child.process);
    const pending = rpc.request("last", {});
    await tick();
    child.stdin.emit("close");
    child.stdout.end(JSON.stringify({ id: child.rows[0].id, result: "final" }));
    assert.equal(await pending, "final");
    child.emit("close", 0);
    assert.equal(rpc.pendingCount, 0);
  });

  it("bounds writes that never clear backpressure", async () => {
    const child = new FakeChild();
    child.stdin = new Writable({ highWaterMark: 1, write: () => undefined });
    const rpc = new CodexRpc(child.process, { writeTimeoutMs: 10 });
    const results = await Promise.allSettled([rpc.notify("stalled"), rpc.request("queued", {})]);
    assert.equal(results.every((value) => value.status === "rejected"), true);
    assert.equal(rpc.pendingCount, 0);
    assert.equal(rpc.closed, true);
  });

  for (const fault of ["error", "close", "stdinError"] as const) {
    it(`rejects every pending request on ${fault} and clears timers`, async () => {
      const child = new FakeChild();
      let faults = 0;
      const rpc = new CodexRpc(child.process, { requestTimeoutMs: 25, onFault: () => { faults++; } });
      const a = rpc.request("a", {});
      const b = rpc.request("b", {});
      const outcomes = Promise.allSettled([a, b]);
      if (fault === "stdinError") child.stdin.emit("error", new Error("secret"));
      else if (fault === "error") child.emit("error", new Error("spawn"));
      else child.emit("close", 1);
      assert.deepEqual((await outcomes).map((value) => value.status), ["rejected", "rejected"]);
      assert.equal(rpc.pendingCount, 0);
      assert.equal(faults, 1);
      child.emit("close", 1);
      child.stdin.emit("error", new Error("late"));
      assert.equal(faults, 1);
    });
  }

  it("bounds RPC timeouts and ignores late responses", async () => {
    const child = new FakeChild();
    const rpc = new CodexRpc(child.process, { requestTimeoutMs: 10 });
    await assert.rejects(rpc.request("hung", {}), (error: unknown) => error instanceof CodexRpcError && error.code === "RPC_TIMEOUT");
    assert.equal(rpc.pendingCount, 0);
    child.result(child.rows[0].id, "too late");
    rpc.dispose();
  });

  it("waits for backpressure before writing subsequent frames", async () => {
    const child = new FakeChild();
    const callbacks: Array<() => void> = [];
    child.stdin = new Writable({ highWaterMark: 1, write: (chunk, _encoding, callback) => {
      child.rows.push(JSON.parse(String(chunk))); callbacks.push(callback);
    } });
    const rpc = new CodexRpc(child.process);
    const a = rpc.notify("a");
    const b = rpc.notify("b");
    assert.equal(child.rows.length, 1);
    callbacks.shift()!();
    await tick();
    assert.equal(child.rows.length, 2);
    callbacks.shift()!();
    await Promise.all([a, b]);
    rpc.dispose();
  });

  it("fails queued writes on callback errors without unhandled pipe errors", async () => {
    const child = new FakeChild();
    child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback(new Error("EPIPE")) });
    const rpc = new CodexRpc(child.process);
    const results = await Promise.allSettled([rpc.notify("a"), rpc.request("b", {})]);
    assert.equal(results.every((value) => value.status === "rejected"), true);
    assert.equal(rpc.pendingCount, 0);
    await tick();
  });

  it("answers unsupported ServerRequests with -32601 and ignores non-JSON noise", async () => {
    const child = new FakeChild();
    const rpc = new CodexRpc(child.process);
    child.stdout.write('noise\n{"id":42,"method":"unknown","params":{"token":"secret"}}\n');
    await tick();
    assert.deepEqual(child.rows[0], { id: 42, error: { code: -32601, message: "Client does not support this server request" } });
    rpc.dispose();
  });
});
