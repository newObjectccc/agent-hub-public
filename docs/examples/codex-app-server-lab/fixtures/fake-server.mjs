#!/usr/bin/env node
/** Protocol fixture only. It never executes model prompts or shell commands. */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.CODEX_LAB_FAKE_MODE ?? "normal";
if (mode === "ignore-term") process.on("SIGTERM", () => {});
const secret = "SECRET_PROTOCOL_BODY_中文_123";
const trace = (message) => {
  if (process.env.CODEX_LAB_FAKE_TRACE) appendFileSync(process.env.CODEX_LAB_FAKE_TRACE, JSON.stringify(message) + "\n");
};
if (process.argv.includes("--version")) {
  trace({ method: "--version" });
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const notify = (method, params) => send({ method, params });
const lock = join(process.cwd(), ".fake-writer.json");
let initialized = false;
let initializeParams;
let threadId = "lab-thread-1";
let turnNumber = 0;
let active;
let approval;
let question;
const response = (request, result) => send({ id: request.id, result });
const rpcError = (request, code, message) => send({ id: request.id, error: { code, message } });
const rollout = join(process.cwd(), "fake-rollout.jsonl");
const thread = () => ({ id: threadId, path: rollout, status: { type: "idle" } });
const agentItem = (value) => ({ type: "agentMessage", id: `agent-${turnNumber}`, text: value });
function complete(status, value, tools = []) {
  const items = value === undefined ? tools : [...tools, agentItem(value)];
  for (const item of items) notify("item/completed", { threadId, turnId: active.id, item });
  notify("turn/completed", { threadId, turn: { id: active.id, status, items, error: status === "failed" ? { message: secret } : null } });
  writeFileSync(lock, JSON.stringify({ active: false, threadId }));
  active = null;
}
function command(commandText) {
  const item = { type: "commandExecution", id: `command-${turnNumber}`, command: commandText, status: "inProgress" };
  active.item = item;
  notify("item/started", { threadId, turnId: active.id, item });
}
function start(request) {
  const prompt = request.params.input?.[0]?.text ?? "";
  active = { id: `lab-turn-${++turnNumber}`, prompt };
  writeFileSync(lock, JSON.stringify({ active: true, threadId }));
  const started = () => notify("turn/started", { threadId, turn: { id: active.id, status: "inProgress", items: [] } });
  if (mode === "wrong-events") {
    notify("turn/completed", { threadId: "other-thread", turn: { id: "old-turn", status: "completed", items: [agentItem("WRONG")] } });
  }
  if (mode === "early-completion") {
    const result = { turn: { id: active.id, status: "inProgress", items: [] } };
    started(); complete("completed", "PONG-X2"); response(request, result); return;
  }
  response(request, { turn: { id: active.id, status: "inProgress", items: [] } });
  started();
  if (mode === "unknown-request" || mode === "unknown-with-completion") {
    send({ id: "unknown-1", method: "unknown/clientRequest", params: { authToken: secret } });
    if (mode === "unknown-with-completion") complete("completed", "PONG-X2");
    return;
  }
  if (mode === "hang-turn") return;
  if (mode === "retry-error") notify("error", { threadId, turnId: active.id, willRetry: true, error: { message: secret } });
  if (mode === "failed-turn" || mode === "no-command") { complete("failed"); return; }
  if (prompt.includes("PONG-X2")) { complete("completed", "PONG-X2"); return; }
  if (prompt.includes("THREE SEPARATE")) { command("sleep 30 && echo LAB_ONE"); return; }
  if (prompt.includes("approval-sample.txt")) {
    approval = { id: "approval-1", turnId: active.id };
    send({ id: approval.id, method: "item/commandExecution/requestApproval", params: {
      threadId, turnId: mode === "wrong-approval-turn" ? "old-turn" : active.id, itemId: `command-${turnNumber}`, cwd: process.cwd(),
      command: mode === "unsafe-approval" ? "rm -rf /; printf x > approval-sample.txt" : "printf '%s' 'APPROVED-BY-PHONE' > 'approval-sample.txt'",
      reason: secret, authToken: secret,
    } });
    return;
  }
  if (prompt.includes("sleep 90")) { command(prompt.includes("A-DONE") ? "sleep 90 && echo A-DONE" : "sleep 90 && echo DONE-SLEEP"); return; }
  if (prompt.includes("request_user_input")) {
    if (mode === "no-question") { complete("completed", "Please choose TypeScript or JavaScript."); return; }
    question = { id: "question-1" };
    send({ id: question.id, method: "item/tool/requestUserInput", params: {
      threadId, turnId: active.id, itemId: "question-item", isBlocking: true,
      questions: [{ id: "language", header: "Language", question: secret, options: [{ label: "TypeScript", description: secret }] }],
    } });
    return;
  }
  const marker = prompt.match(/Reply with exactly: ([A-Z0-9-]+)/)?.[1];
  complete("completed", marker ?? "FAKE");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  trace(request);
  if (request.method === "initialize") { initializeParams = request.params; response(request, { userAgent: "fake-server", authToken: secret }); return; }
  if (request.method === "initialized") { initialized = true; return; }
  if (approval && request.id === approval.id && !request.method) {
    const allowed = request.result?.decision === "accept";
    if (allowed || mode === "decline-writes") writeFileSync(join(process.cwd(), "approval-sample.txt"), "APPROVED-BY-PHONE");
    const item = { type: "commandExecution", id: `command-${turnNumber}`, status: allowed ? "completed" : "declined", exitCode: allowed ? 0 : null };
    approval = null; complete("completed", allowed ? "CREATED" : "BLOCKED", [item]); return;
  }
  if (question && request.id === question.id && !request.method) { question = null; complete("completed", "Please choose TypeScript or JavaScript."); return; }
  if (!request.method) { notify("fake/clientReply", request); return; }
  if (!initialized) { rpcError(request, -32000, "initialized is required"); return; }
  switch (request.method) {
    case "model/list": response(request, { data: [{ id: "gpt-fake", displayName: secret }], authToken: secret }); break;
    case "account/read":
      if (mode === "legacy-account") rpcError(request, -32601, secret);
      else response(request, { account: { type: "chatgpt", email: secret }, authToken: secret });
      break;
    case "getAuthStatus": response(request, { authMethod: "chatgpt", authToken: secret }); break;
    case "thread/list": response(request, { data: [{ id: "private-never-resume", preview: secret, path: secret, historyMode: "paginated" }], nextCursor: null }); break;
    case "experimentalFeature/list": case "permissionProfile/list": response(request, { data: [{ name: secret }] }); break;
    case "thread/start": writeFileSync(rollout, JSON.stringify({ fixture: true }) + "\n"); notify("thread/started", { thread: thread() }); response(request, { thread: thread() }); break;
    case "thread/resume": {
      const activeWriter = existsSync(lock) && JSON.parse(readFileSync(lock, "utf8")).active;
      if (activeWriter && mode !== "allow-writer") rpcError(request, -32600, `thread already has an active writer ${secret}`);
      else { threadId = request.params.threadId; response(request, { thread: thread() }); }
      break;
    }
    case "thread/unsubscribe": response(request, {}); break;
    case "turn/start": start(request); break;
    case "turn/steer":
      response(request, { turnId: mode === "steer-new-turn" ? "different-turn" : active.id });
      complete("completed", "HELLO-STEER-3", [{ ...active.item, status: "completed", exitCode: 0 }]);
      break;
    case "turn/interrupt": response(request, {}); complete("interrupted", undefined, [{ ...active.item, status: "interrupted" }]); break;
    case "fake/state": response(request, { initialized, initializeParams, cwd: process.cwd(), injected: process.env.FAKE_INJECTED }); break;
    case "fake/emit": response(request, {}); for (const event of request.params.events) send(event); break;
    case "fake/error": rpcError(request, -32001, secret); break;
    case "fake/hang": break;
    case "fake/crash": process.exit(7); break;
    case "fake/bad-json": process.stdout.write("{not-json SECRET\n"); break;
    case "fake/oversize": process.stdout.write("x".repeat(4096)); break;
    case "fake/unexpected-response": send({ id: 999999, result: { authToken: secret } }); break;
    case "fake/stderr": process.stderr.write(secret); response(request, {}); break;
    case "fake/serverRequest": response(request, {}); send({ id: 91, method: request.params.method ?? "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: secret, authToken: secret } }); break;
    case "fake/utf8": {
      response(request, {});
      const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "fake/unicode", params: { text: "中文🙂尾" } }) + "\n");
      const split = data.indexOf(Buffer.from("中")) + 1;
      process.stdout.write(data.subarray(0, split));
      setImmediate(() => process.stdout.write(data.subarray(split)));
      break;
    }
    case "fake/tail": process.stdout.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "中文尾行" } })); break;
    default: rpcError(request, -32601, secret);
  }
});
