/**
 * X2–X7 实验入口：node exp.mjs <case>
 * case: x2a | x2b | x3 | x4decline | x4accept | x5 | x6 | x7
 * 全部在 /tmp/codex-lab/ws 沙箱 cwd 内，不触碰用户项目工作区。
 */
import { AppServer, text, sleep, section } from "./lab.mjs";
import { loadShellProviderEnv, keyNames } from "./env.mjs";

const SHELL_ENV = loadShellProviderEnv();
console.log("injected provider env keys:", keyNames(SHELL_ENV) || "(none)");
const EXTRA = (process.env.CODEX_LAB_ARGS ?? "").split("|").filter(Boolean);
const BIN = process.env.CODEX_LAB_BIN ?? "codex";
const mk = (label) => new AppServer({ label, env: SHELL_ENV, args: EXTRA, bin: BIN });
console.log("codex bin:", BIN);
if (EXTRA.length) console.log("app-server extra args:", EXTRA.join(" "));
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const LAB = process.env.CODEX_LAB_DIR ?? "/tmp/codex-lab";   // 沙箱根（绝不指向项目工作区）
const WS = process.env.CODEX_LAB_WS ?? LAB + "/ws";           // 实验 cwd（首次会自动 git init 以免 exec 通道拒收）
mkdirSync(WS, { recursive: true });

const SANDBOX_WS = {
  type: "workspaceWrite",
  writableRoots: [WS, LAB],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};
const SANDBOX_RO = { type: "readOnly", networkAccess: false };

const init = async (as) => {
  const r = await as.request("initialize", {
    clientInfo: { name: "agent-hub-lab", title: "agent-hub codex 接管验证", version: "0.0.1" },
  }, 30_000);
  as.log("INIT-OK", JSON.stringify(r).slice(0, 200));
  return r;
};

const MODEL = process.env.CODEX_LAB_MODEL ?? null; // 默认不覆盖 → 用 ~/.codex/config.toml 的 model
const turnOpts = { effort: "low", ...(MODEL ? { model: MODEL } : {}) };
const threadModel = MODEL ? { model: MODEL } : {};
const POLICY = process.env.CODEX_LAB_POLICY ?? "untrusted";

async function x2a() {
  section("X2a thread/resume 历史会话（不发消息）——能否加载 + status 变化");
  const as = mk("x2a").start();
  await init(as);
  const list = await as.request("thread/list", { limit: 3 }, 30_000);
  const target = list.data?.find((t) => t.status?.type === "notLoaded") ?? list.data?.[0];
  if (!target) { as.log("NO-THREAD"); await as.close(); return; }
  as.log("TARGET", JSON.stringify({ id: target.id, status: target.status, cwd: target.cwd, path: target.path, source: target.source, cliVersion: target.cliVersion }).slice(0, 400));
  const sizeBefore = existsSync(target.path) ? statSync(target.path).size : -1;
  const res = await as.request("thread/resume", { threadId: target.id }, 90_000);
  as.log("RESUME-OK", JSON.stringify({
    threadId: res.thread?.id, status: res.thread?.status, model: res.model, approvalPolicy: res.approvalPolicy,
    sandbox: res.sandbox, cwd: res.cwd, approvalsReviewer: res.approvalsReviewer, reasoningEffort: res.reasoningEffort,
  }).slice(0, 500));
  const sizeAfter = existsSync(target.path) ? statSync(target.path).size : -1;
  as.log(`ROLLOUT-SIZE before=${sizeBefore} after=${sizeAfter} (resume 是否写盘)`);
  // 分页读历史（hub 可替代自研 rollout 解析？）
  try {
    const read = await as.request("thread/read", { threadId: target.id }, 60_000);
    const items = read.items ?? read.thread?.items ?? [];
    as.log(`THREAD-READ items=${Array.isArray(items) ? items.length : "?"} keys=${Object.keys(read).join(",")}`);
  } catch (e) { as.log("THREAD-READ-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300)); }
  try { await as.request("thread/unsubscribe", { threadId: target.id }, 15_000); as.log("UNSUBSCRIBE-OK"); }
  catch (e) { as.log("UNSUBSCRIBE-ERR", e.message); }
  as.log("EVENTS\n" + as.timeline());
  await as.close();
}

async function x2b() {
  section("X2b thread/start + turn/start —— 事件流 / rollout 落盘 / turn 收尾");
  const as = mk("x2b").start();
  await init(as);
  const st = await as.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: "never", ...threadModel }, 60_000);
  const threadId = st.thread.id;
  as.log("THREAD-START", JSON.stringify({ threadId, sessionId: st.thread.sessionId, model: st.model, approvalPolicy: st.approvalPolicy, sandbox: st.sandbox, cwd: st.cwd }).slice(0, 400));
  const rolloutPath = st.thread.path ?? null;
  as.log("ROLLOUT-PATH", rolloutPath);
  const done = as.waitFor((e) => e.method === "turn/completed", 180_000, "turn/completed");
  const res = await as.request("turn/start", { threadId, input: [text("Reply with exactly: PONG-X2. Do not call any tools.")], ...turnOpts }, 180_000);
  as.log("TURN-START-RESP", JSON.stringify({ turnId: res.turn?.id, status: res.turn?.status, items: res.turn?.items?.length }).slice(0, 300));
  const completed = await done;
  as.log("TURN-COMPLETED?", completed ? `yes status=${completed.params?.turn?.status ?? "?"}` : "NO");
  const size = rolloutPath && existsSync(rolloutPath) ? statSync(rolloutPath).size : -1;
  as.log(`ROLLOUT-SIZE=${size}`);
  if (rolloutPath && size > 0) {
    const lines = readFileSync(rolloutPath, "utf8").trim().split("\n");
    as.log(`ROLLOUT-LINES=${lines.length} types=${lines.slice(-6).map((l) => { try { const j = JSON.parse(l); return j.type ?? j.payload?.type ?? "?"; } catch { return "bad"; } }).join(",")}`);
    as.log("ROLLOUT-TAIL", lines[lines.length - 1].slice(0, 300));
  }
  as.log("EVENTS\n" + as.timeline());
  as.log("SERVER-REQUESTS", as.serverRequests.map((r) => r.method).join(",") || "(none)");
  await as.close();
  writeFileSync("/tmp/codex-lab/x2b-thread.json", JSON.stringify({ threadId, rolloutPath }));
}

async function x3() {
  section("X3 运行中 turn/steer —— 是否立刻转向（对比 claude 的工具间隙注入）");
  const as = mk("x3").start();
  await init(as);
  const st = await as.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: "never", ...threadModel }, 60_000);
  const threadId = st.thread.id;
  as.log("THREAD", threadId, "rollout", st.thread.path);
  const done = as.waitFor((e) => e.method === "turn/completed", 240_000, "turn/completed");
  const started = as.waitFor((e) => e.method === "turn/started", 60_000, "turn/started");
  await as.request("turn/start", {
    threadId,
    input: [text("Run these three shell commands as THREE SEPARATE tool calls, one after another: (1) `sleep 8 && echo ONE` (2) `sleep 8 && echo TWO` (3) `sleep 8 && echo THREE`. After all three, reply with the collected outputs.")],
    ...turnOpts,
  }, 240_000);
  const ts = await started;
  const turnId = ts?.params?.turn?.id;
  as.log("ACTIVE-TURN", turnId);
  // 第一个命令执行中注入 steer（当前环境模型 400 会让 turn 在 ~6s 内 fail，故提前到窗口内）
  await sleep(6500);
  as.log("STEERING（第一条 sleep 命令执行中）...");
  try {
    const sr = await as.request("turn/steer", {
      threadId, expectedTurnId: turnId,
      input: [text("Stop the remaining commands immediately. Do not run TWO or THREE. Reply with exactly: HELLO-STEER-3")],
    }, 60_000);
    as.log("STEER-RESP", JSON.stringify(sr).slice(0, 400));
  } catch (e) {
    as.log("STEER-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 400));
  }
  const completed = await done;
  as.log("TURN-COMPLETED status=", completed?.params?.turn?.status);
  const items = completed?.params?.turn?.items ?? [];
  as.log("FINAL-ITEMS", items.map((i) => `${i.type}${i.command ? `(${String(i.command).slice(0, 40)})` : ""}${i.status ? `[${i.status}]` : ""}${i.text ? `=${JSON.stringify(i.text).slice(0, 80)}` : ""}`).join(" | ").slice(0, 1200));
  as.log("EVENTS\n" + as.timeline());
  await as.close();
}

async function x4(decision) {
  section(`X4 审批 requestApproval → ${decision}（sandbox=workspace-write + approvalPolicy=${POLICY}）`);
  const as = mk(`x4-${decision}`).start();
  await init(as);
  const st = await as.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: POLICY, ...threadModel }, 60_000);
  const threadId = st.thread.id;
  as.log("THREAD", threadId, "approvalPolicy", st.approvalPolicy, "sandbox", JSON.stringify(st.sandbox));
  as.onServerRequest = (method, params) => {
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      as.log(`APPROVAL-REQUEST command=${JSON.stringify(params.command ?? params.call ?? "").slice(0, 200)} reason=${JSON.stringify(params.reason ?? "").slice(0, 160)}`);
      return { decision };
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      as.log(`FILE-APPROVAL-REQUEST ${JSON.stringify(params).slice(0, 200)}`);
      return { decision };
    }
    if (method === "item/permissions/requestApproval") {
      as.log(`PERMISSIONS-REQUEST ${JSON.stringify(params).slice(0, 300)}`);
      return undefined; // 形状复杂，先记录不应答
    }
    as.log(`UNHANDLED-SERVER-REQUEST ${method} ${JSON.stringify(params).slice(0, 200)}`);
    return undefined;
  };
  const done = as.waitFor((e) => e.method === "turn/completed", 240_000, "turn/completed");
  await as.request("turn/start", {
    threadId,
    input: [text("Create a file named lab-approval.txt in the current directory containing exactly the text APPROVED-BY-PHONE, using a shell command. If you are not allowed, just say BLOCKED and stop.")],
    ...turnOpts,
  }, 240_000).catch((e) => as.log("TURN-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300)));
  const completed = await done;
  as.log("TURN-COMPLETED status=", completed?.params?.turn?.status, "error=", JSON.stringify(completed?.params?.turn?.error ?? null).slice(0, 300));
  const items = completed?.params?.turn?.items ?? [];
  as.log("FINAL-ITEMS", items.map((i) => `${i.type}${i.command ? `(${String(i.command).slice(0, 50)})` : ""}${i.status ? `[${i.status}]` : ""}${i.text ? `=${JSON.stringify(i.text).slice(0, 100)}` : ""}`).join(" | ").slice(0, 1400));
  as.log("FILE-CREATED?", existsSync(`${WS}/lab-approval.txt`) ? readFileSync(`${WS}/lab-approval.txt`, "utf8") : "NO");
  as.log("SERVER-REQUESTS", as.serverRequests.map((r) => `${r.ms}ms ${r.method}`).join(" | ") || "(none)");
  as.log("EVENTS\n" + as.timeline());
  // 关键：进程是否存活可接下一条（decline 不卡死）
  try {
    const r2 = await as.request("turn/start", { threadId, input: [text("Reply with exactly: ALIVE-AFTER-" + decision.toUpperCase())], ...turnOpts }, 120_000);
    as.log("PROCESS-ALIVE yes, turn2=", r2.turn?.id, "status=", r2.turn?.status);
  } catch (e) {
    as.log("PROCESS-ALIVE NO:", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300));
  }
  await as.close();
}

async function x5() {
  section("X5 turn/interrupt —— 中止后进程存活、可接下一条");
  const as = mk("x5").start();
  await init(as);
  const st = await as.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: "never", ...threadModel }, 60_000);
  const threadId = st.thread.id;
  const started = as.waitFor((e) => e.method === "turn/started", 60_000, "turn/started");
  const done = as.waitFor((e) => e.method === "turn/completed", 180_000, "turn/completed");
  await as.request("turn/start", {
    threadId,
    input: [text("Run this shell command: `sleep 30 && echo DONE-SLEEP`. Then reply FINISHED.")],
    ...turnOpts,
  }, 180_000).catch((e) => as.log("TURN-ERR", e.message));
  const ts = await started;
  const turnId = ts?.params?.turn?.id;
  await sleep(6000);
  as.log("INTERRUPTING turn", turnId);
  try {
    const ir = await as.request("turn/interrupt", { threadId, turnId }, 30_000);
    as.log("INTERRUPT-RESP", JSON.stringify(ir).slice(0, 400));
  } catch (e) { as.log("INTERRUPT-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300)); }
  const completed = await done;
  as.log("TURN-COMPLETED status=", completed?.params?.turn?.status, "error=", JSON.stringify(completed?.params?.turn?.error ?? null).slice(0, 200));
  // 进程存活验证
  try {
    const r2 = await as.request("turn/start", { threadId, input: [text("Reply with exactly: ALIVE-X5")], ...turnOpts }, 120_000);
    as.log("ALIVE-X5 turn2 status=", r2.turn?.status, "items=", r2.turn?.items?.map((i) => i.type).join(","));
    as.log("ALIVE-X5 text=", JSON.stringify(r2.turn?.items?.filter((i) => i.type === "agentMessage").map((i) => i.text)).slice(0, 200));
  } catch (e) { as.log("ALIVE-X5 FAIL:", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300)); }
  as.log("EXIT-INFO", JSON.stringify(as.exitInfo));
  as.log("EVENTS\n" + as.timeline());
  await as.close();
}

async function x6() {
  section("X6 双客户端：A 正在跑 turn，B thread/resume 同一 thread —— rejoin 还是冲突");
  const A = mk("A").start();
  await init(A);
  const st = await A.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: "never", ...threadModel }, 60_000);
  const threadId = st.thread.id;
  const rolloutPath = st.thread.path;
  A.log("THREAD", threadId, rolloutPath);
  A.request("turn/start", {
    threadId,
    input: [text("Run `sleep 25 && echo A-DONE` in the shell, then reply FINISHED-A.")],
    ...turnOpts,
  }, 180_000).catch((e) => A.log("A-TURN-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 200)));
  await sleep(4000);
  const B = mk("B").start();
  await init(B);
  B.log("RESUMING same running thread from a SECOND app-server process ...");
  try {
    const r = await B.request("thread/resume", { threadId }, 90_000);
    B.log("B-RESUME-OK", JSON.stringify({ status: r.thread?.status, model: r.model, approvalPolicy: r.approvalPolicy, cwd: r.cwd }).slice(0, 400));
  } catch (e) {
    B.log("B-RESUME-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 500));
  }
  await sleep(6000);
  B.log("B 收到 A 那轮的通知？", B.events.map((e) => e.method).join(",") || "(none)");
  // B 尝试对同一 thread 发 turn（真双写测试）
  try {
    const br = await B.request("turn/start", { threadId, input: [text("Reply with exactly: FROM-B")], ...turnOpts }, 90_000);
    B.log("B-TURN-OK status=", br.turn?.status, "items=", br.turn?.items?.map((i) => i.type).join(","));
  } catch (e) {
    B.log("B-TURN-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 500));
  }
  await sleep(3000);
  A.log("A 侧事件（B 介入后）\n" + A.timeline().split("\n").slice(-14).join("\n"));
  B.log("B 侧事件\n" + B.timeline().split("\n").slice(-20).join("\n"));
  const size = rolloutPath && existsSync(rolloutPath) ? statSync(rolloutPath).size : -1;
  console.log(`ROLLOUT-SIZE=${size} path=${rolloutPath}`);
  await B.close();
  await A.close();
}

async function x7() {
  section("X7 item/tool/requestUserInput —— 模型主动向手机提问（claude 缺口）");
  const as = mk("x7").start();
  await init(as);
  const st = await as.request("thread/start", { cwd: WS, sandbox: "workspace-write", approvalPolicy: "never", ...threadModel }, 60_000);
  const threadId = st.thread.id;
  as.onServerRequest = (method, params) => {
    if (method === "item/tool/requestUserInput") {
      as.log("USER-INPUT-REQUEST", JSON.stringify(params).slice(0, 600));
      const q = params.questions?.[0];
      const answer = q?.options?.[0] ?? (q ? "TypeScript" : undefined);
      return { answers: [{ questionId: q?.id ?? "q1", answer: typeof answer === "object" ? JSON.stringify(answer) : String(answer) }] };
    }
    as.log("OTHER-SERVER-REQUEST", method, JSON.stringify(params).slice(0, 200));
    return undefined;
  };
  const done = as.waitFor((e) => e.method === "turn/completed", 180_000, "turn/completed");
  await as.request("turn/start", {
    threadId,
    input: [text("Use the request_user_input tool to ask me whether I prefer TypeScript or JavaScript before doing anything else. Do not decide for me.")],
    ...turnOpts,
  }, 180_000).catch((e) => as.log("TURN-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 300)));
  const completed = await done;
  as.log("TURN-COMPLETED status=", completed?.params?.turn?.status);
  as.log("SERVER-REQUESTS", as.serverRequests.map((r) => `${r.ms}ms ${r.method}`).join(" | ") || "(none)");
  as.log("EVENTS\n" + as.timeline());
  await as.close();
}

const cases = { x2a, x2b, x3, x5, x6, x7, x4decline: () => x4("decline"), x4accept: () => x4("accept") };
const name = process.argv[2];
if (!cases[name]) {
  console.log("usage: node exp.mjs <" + Object.keys(cases).join("|") + ">");
  process.exit(2);
}
await cases[name]();
process.exit(0);
