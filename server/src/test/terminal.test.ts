/**
 * ttyd Web 终端（F2，契约 §13）单测：纯函数（端口解析 / 启动计划 / shim 注入 / token 提取）
 * + TerminalService 生命周期（fake spawn/execFile）：探测降级、按需拉起、token 签发与失效、回收。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  allocPort,
  buildTtydSpawnPlan,
  injectTerminalShim,
  installHint,
  parseTtydListenPort,
  redactUrlSecrets,
  TerminalService,
  tokenFrom,
  WINDOWS_UNSUPPORTED_HINT,
  type TerminalChildProcess,
  type TerminalSpawnFn,
} from "../terminal.js";

// ---------- fake ttyd 子进程 ----------

class FakeChild {
  killed = false;
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();

  readonly stdout = {
    on: (event: string, cb: (chunk: Buffer | string) => void): void => this.add(`stdout:${event}`, cb as never),
  };
  readonly stderr = {
    on: (event: string, cb: (chunk: Buffer | string) => void): void => this.add(`stderr:${event}`, cb as never),
  };

  private add(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  on(event: string, cb: (...args: never[]) => void): this {
    this.add(event, cb);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emitExit(0));
    return true;
  }

  emitStdout(text: string): void {
    for (const h of this.handlers.get("stdout:data") ?? []) h(text as never);
  }
  emitStderr(text: string): void {
    for (const h of this.handlers.get("stderr:data") ?? []) h(text as never);
  }
  emitExit(code: number | null): void {
    for (const h of this.handlers.get("exit") ?? []) h(code as never);
  }
  emitError(err: Error): void {
    for (const h of this.handlers.get("error") ?? []) h(err as never);
  }
}

interface FakeSpawnResult {
  spawnFn: TerminalSpawnFn;
  calls: Array<{ bin: string; args: string[] }>;
  children: FakeChild[];
}

function fakeSpawn(options: { mode?: "listen" | "exit" | "silent" | "error"; port?: number } = {}): FakeSpawnResult {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnFn: TerminalSpawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    const mode = options.mode ?? "listen";
    const idx = args.indexOf("--port");
    const declaredPort = idx >= 0 ? Number.parseInt(args[idx + 1], 10) : 0;
    queueMicrotask(() => {
      if (mode === "listen") {
        child.emitStdout(`[2026/02/18 12:00:00] N: ttyd (version 1.7.7)\n`);
        child.emitStderr(`Listening on '127.0.0.1:${options.port ?? declaredPort}'\n`);
      } else if (mode === "exit") {
        child.emitStderr("ttyd: unrecognized option\n");
        child.emitExit(2);
      } else if (mode === "error") {
        child.emitError(new Error("spawn ttyd ENOENT"));
      }
      // silent：既不打日志也不退出（走 TCP 兜底/超时）
    });
    return child as unknown as TerminalChildProcess;
  };
  return { spawnFn, calls, children };
}

/** fake execFile：which/where + ttyd --version 探测 */
function fakeExecFile(options: { installed?: boolean; versionOutput?: string } = {}) {
  const installed = options.installed ?? true;
  return ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
    queueMicrotask(() => {
      if ((cmd === "which" || cmd === "where") && args[0] === "ttyd") {
        cb(installed ? null : new Error("not found"), installed ? "/usr/local/bin/ttyd\n" : "");
        return;
      }
      if (cmd === "ttyd") {
        cb(installed ? null : new Error("not found"), installed ? (options.versionOutput ?? "ttyd version 1.7.7\n") : "");
        return;
      }
      cb(new Error(`unexpected: ${cmd}`), "");
    });
  }) as never;
}

// ---------- 纯函数 ----------

describe("terminal: 纯函数", () => {
  it("parseTtydListenPort：两种日志格式", () => {
    assert.equal(parseTtydListenPort("Listening on '127.0.0.1:7681'"), 7681);
    assert.equal(parseTtydListenPort("Listening on port 7682"), 7682);
    assert.equal(parseTtydListenPort("just banner"), null);
    assert.equal(parseTtydListenPort(""), null);
  });

  it("buildTtydSpawnPlan：loopback 绑定 + 可写 + 随机 Basic 凭证 + 用户 shell", () => {
    const plan = buildTtydSpawnPlan({ port: 54321, shell: "/bin/zsh", randomToken: () => "tok-abc" });
    assert.equal(plan.bin, "ttyd");
    assert.deepEqual(plan.args.slice(0, 2), ["--port", "54321"]);
    assert.ok(plan.args.includes("127.0.0.1"), "必须仅绑定 loopback");
    assert.ok(plan.args.includes("--interface"));
    assert.ok(plan.args.includes("--writable"), "ttyd 默认只读，真终端需要 --writable");
    assert.equal(plan.args[plan.args.length - 1], "/bin/zsh");
    assert.equal(plan.credential, "hub:tok-abc");
    // 凭证只出现在 --credential 参数里（服务端自用，不进日志/响应）
    assert.ok(plan.args.includes(plan.credential));
  });

  it("injectTerminalShim：/ws 改写到 /terminal/ws + 绝对资源路径改写", () => {
    const html = `<html><head><title>ttyd</title></head><body><script src="/token-abc/main.js"></script></body></html>`;
    const out = injectTerminalShim(html);
    assert.ok(out.includes("data-agent-hub-terminal-shim"), "注入 WS shim");
    assert.ok(out.includes('"/terminal/ws"'), "ws 路径改写到反代前缀");
    assert.ok(out.includes('src="/terminal/token-abc/main.js"'), "绝对资源路径改写到反代前缀");
    // 相对资源不动
    const rel = injectTerminalShim(`<html><head></head><script src="main.js"></script></html>`);
    assert.ok(rel.includes('src="main.js"'));
  });

  it("tokenFrom：查询串优先，Cookie 兜底", () => {
    assert.equal(tokenFrom("/terminal/?t=abc&x=1", undefined), "abc");
    assert.equal(tokenFrom("/terminal/ws", "hub-terminal-token=cook-tok; a=b"), "cook-tok");
    assert.equal(tokenFrom("/terminal/ws", "other=1"), null);
    assert.equal(tokenFrom(undefined, undefined), null);
  });

  it("redactUrlSecrets：日志脱敏，token 不进访问日志（P2）", () => {
    // `?t=` 终端 token：值替换为 [REDACTED]，path / 非敏感查询保留
    assert.equal(redactUrlSecrets("/terminal/?t=SECRET123&x=1"), "/terminal/?t=[REDACTED]&x=1");
    assert.equal(redactUrlSecrets("/ws?token=abc&room=2"), "/ws?token=[REDACTED]&room=2");
    assert.equal(redactUrlSecrets("/api/x?access_token=k1&lock_token=k2&sig=k3"), "/api/x?access_token=[REDACTED]&lock_token=[REDACTED]&sig=[REDACTED]");
    // 无查询串 / 非敏感键原样
    assert.equal(redactUrlSecrets("/terminal/"), "/terminal/");
    assert.equal(redactUrlSecrets("/api/sessions?limit=5"), "/api/sessions?limit=5");
    // 键名大小写不敏感；无值的键保持原样
    assert.equal(redactUrlSecrets("/a?TOKEN=z&flag"), "/a?TOKEN=[REDACTED]&flag");
  });

  it("installHint：跨平台安装提示 / Windows 降级", () => {
    assert.equal(installHint("darwin"), "未安装（brew install ttyd）");
    assert.equal(installHint("linux"), "未安装（sudo apt install ttyd）");
    assert.equal(WINDOWS_UNSUPPORTED_HINT, "不支持（WSL 内可用）");
  });
});

// ---------- TerminalService 生命周期 ----------

describe("terminal: TerminalService", () => {
  it("status：未安装给安装提示；win32 直接降级", async () => {
    const mac = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExecFile({ installed: false }),
      spawnFn: fakeSpawn().spawnFn,
    });
    const status = await mac.status();
    assert.equal(status.supported, true);
    assert.equal(status.installed, false);
    assert.equal(status.running, false);
    assert.equal(status.hint, "未安装（brew install ttyd）");
    mac.dispose();

    const win = new TerminalService({ platform: "win32", execFileFn: fakeExecFile({ installed: true }) });
    const winStatus = await win.status();
    assert.equal(winStatus.supported, false);
    assert.equal(winStatus.hint, WINDOWS_UNSUPPORTED_HINT);
    win.dispose();
  });

  it("ensureSession：未安装 / 不支持 → TERMINAL_UNAVAILABLE", async () => {
    const svc = new TerminalService({ platform: "darwin", execFileFn: fakeExecFile({ installed: false }) });
    await assert.rejects(() => svc.ensureSession(), (err: Error & { code?: string }) => {
      assert.equal(err.code, "TERMINAL_UNAVAILABLE");
      assert.ok(err.message.includes("brew install ttyd"));
      return true;
    });
    svc.dispose();
  });

  it("ensureSession：按需拉起 ttyd（loopback + 随机凭证）并签发 token URL", async () => {
    const fake = fakeSpawn();
    const svc = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExecFile(),
      spawnFn: fake.spawnFn,
      readyTimeoutMs: 2_000,
    });
    const session = await svc.ensureSession();
    assert.match(session.url, /^\/terminal\/\?t=/);
    const token = decodeURIComponent(session.url.split("?t=")[1]);
    assert.ok(svc.validateToken(token), "签发的 token 可用");
    assert.equal(svc.validateToken("bogus"), false);
    assert.equal(svc.validateToken(null), false);
    assert.equal(fake.calls.length, 1);
    const { args } = fake.calls[0];
    assert.ok(args.includes("127.0.0.1") && args.includes("--interface"), "仅绑定 loopback");
    assert.ok(args.includes("--writable"));
    const credIdx = args.indexOf("--credential");
    assert.ok(credIdx > 0 && args[credIdx + 1].startsWith("hub:"), "随机 Basic 凭证");

    // 已运行：复用实例（不重复 spawn），只发新 token
    const again = await svc.ensureSession();
    assert.equal(fake.calls.length, 1);
    assert.notEqual(again.url, session.url);
    const status = await svc.status();
    assert.equal(status.running, true);

    await svc.stop();
    assert.equal(fake.children[0].killed, true, "stop 杀掉 ttyd");
    assert.equal(svc.validateToken(token), false, "stop 后 token 作废");
    assert.equal((await svc.status()).running, false);
    svc.dispose();
  });

  it("ensureSession：ttyd 启动失败（退出/未就绪）→ TERMINAL_UNAVAILABLE 且状态复位", async () => {
    const exitFake = fakeSpawn({ mode: "exit" });
    const svc = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExecFile(),
      spawnFn: exitFake.spawnFn,
      readyTimeoutMs: 300,
    });
    await assert.rejects(() => svc.ensureSession(), (err: Error & { code?: string }) => {
      assert.equal(err.code, "TERMINAL_UNAVAILABLE");
      return true;
    });
    assert.equal(exitFake.children[0].killed, true, "失败时回收子进程");
    assert.equal(svc.proxyTarget(), null);
    svc.dispose();

    const silentFake = fakeSpawn({ mode: "silent" });
    const silent = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExecFile(),
      spawnFn: silentFake.spawnFn,
      readyTimeoutMs: 200,
    });
    await assert.rejects(() => silent.ensureSession(), (err: Error & { code?: string }) => err.code === "TERMINAL_UNAVAILABLE");
    silent.dispose();
  });

  it("token TTL 过期失效（注入 now）", async () => {
    let now = 1_000_000;
    const fake = fakeSpawn();
    const svc = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExecFile(),
      spawnFn: fake.spawnFn,
      now: () => now,
      tokenTtlMs: 60_000,
      readyTimeoutMs: 2_000,
    });
    const session = await svc.ensureSession();
    const token = decodeURIComponent(session.url.split("?t=")[1]);
    now += 59_000;
    assert.ok(svc.validateToken(token));
    now += 2_000;
    assert.equal(svc.validateToken(token), false, "过期 token 拒绝");
    svc.dispose();
  });

  it("allocPort：返回可用高端口", async () => {
    const port = await allocPort();
    assert.ok(port > 1024 && port < 65_536);
  });
});
