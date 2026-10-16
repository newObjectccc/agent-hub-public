/** Model experiments require --run. Existing history also requires an explicit --thread. */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { text, UNSUPPORTED, labError } from "./lab.mjs";
import { executeRun, parseOptions, reportCliError } from "./run.mjs";

const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const modelOptions = () => process.env.CODEX_LAB_MODEL ? { model: process.env.CODEX_LAB_MODEL } : {};
const turnOptions = () => ({ effort: "low", ...modelOptions() });
const messages = (turn) => (turn.items ?? []).filter((item) => item.type === "agentMessage").map((item) => item.text ?? "").join("").trim();

async function newThread(run, server, approvalPolicy = "never", sandbox = "read-only") {
  await server.initialize();
  const result = await server.request("thread/start", { cwd: run.cwd, sandbox, approvalPolicy, ...modelOptions() });
  run.check("new isolated thread has an id", typeof result.thread?.id === "string" && result.thread.id.length > 0);
  run.artifact.threadId = result.thread.id;
  run.createdRollouts ??= new Map();
  if (typeof result.thread.path === "string") run.createdRollouts.set(result.thread.id, result.thread.path);
  return result.thread.id;
}

async function startTurn(run, server, threadId, prompt) {
  const after = server.cursor;
  const result = await server.request("turn/start", { threadId, input: [text(prompt)], ...turnOptions() });
  const turnId = result.turn?.id;
  run.check("turn start returns an id", typeof turnId === "string" && turnId.length > 0);
  const scope = { threadId, turnId, after, timeoutMs: run.timeoutMs };
  const started = await server.waitFor("turn/started", scope);
  run.check("turn started is correlated and in progress", started.params.turn?.status === "inProgress");
  return scope;
}

async function terminalTurn(run, server, scope, expected, checkName = "turn reached expected terminal status") {
  const event = await server.waitFor("turn/completed", scope);
  run.check("turn completion is correlated", event.params.turn?.id === scope.turnId);
  run.check("turn has a terminal status", TERMINAL.has(event.params.turn?.status));
  run.check(checkName, event.params.turn.status === expected);
  run.artifact.turns ??= [];
  run.artifact.turns.push({ threadId: scope.threadId, turnId: scope.turnId, status: event.params.turn.status });
  return event.params.turn;
}

function commandStillRunning(run, server, scope, itemId) {
  run.check("command has not completed before control request", !server.events.some((event) =>
    event.seq > scope.after && event.threadId === scope.threadId && event.turnId === scope.turnId &&
    (event.method === "turn/completed" || (event.method === "item/completed" && event.itemId === itemId))));
}

async function runningCommand(run, server, scope) {
  const event = await server.waitFor((candidate) =>
    (candidate.method === "item/started" && candidate.params.item?.type === "commandExecution") || candidate.method === "turn/completed", scope);
  run.check("observed command start before turn finished", event.method === "item/started" && event.params.item?.status === "inProgress");
  commandStillRunning(run, server, scope, event.itemId);
  return event;
}

async function assertAlive(run, server, threadId, marker) {
  const scope = await startTurn(run, server, threadId, `Reply with exactly: ${marker}. Do not call tools.`);
  const turn = await terminalTurn(run, server, scope, "completed", "follow-up turn completed");
  run.check("follow-up response matches marker", messages(turn) === marker);
  run.check("app-server remains alive", server.exitInfo === null);
}

async function x2a(run, options) {
  // Resume can acquire a writer and update metadata even without turn/start.
  if (!options.thread) throw labError("EXPLICIT_THREAD_REQUIRED");
  const server = run.server();
  await server.initialize();
  const result = await server.request("thread/resume", { threadId: options.thread, excludeTurns: true });
  run.check("resumed only the explicitly selected thread", result.thread?.id === options.thread);
  run.check("resume reports a known thread status", ["idle", "active", "systemError", "notLoaded"].includes(result.thread?.status?.type));
  run.artifact.resumeStatus = result.thread.status.type;
  await server.request("thread/unsubscribe", { threadId: options.thread });
  run.check("unsubscribe acknowledged; process closes to release ownership", true);
}

async function x2b(run) {
  const server = run.server();
  const threadId = await newThread(run, server);
  const scope = await startTurn(run, server, threadId, "Reply with exactly: PONG-X2. Do not call any tools.");
  const turn = await terminalTurn(run, server, scope, "completed");
  run.check("response matches the requested marker", messages(turn) === "PONG-X2");
  run.check("minimal turn made no command calls", !(turn.items ?? []).some((item) => item.type === "commandExecution"));
  const rollout = run.createdRollouts.get(threadId);
  run.check("new thread has a nonempty rollout file", typeof rollout === "string" && isAbsolute(rollout) && rollout.endsWith(".jsonl") && existsSync(rollout) && statSync(rollout).isFile() && statSync(rollout).size > 0);
  run.artifact.rollout = { reference: rollout, bytes: statSync(rollout).size };
}

async function x3(run) {
  const server = run.server();
  const threadId = await newThread(run, server);
  const scope = await startTurn(run, server, threadId,
    "Run these as THREE SEPARATE shell tool calls in order: (1) `sleep 30 && echo LAB_ONE` (2) `echo LAB_TWO` (3) `echo LAB_THREE`. Then report outputs.");
  const command = await runningCommand(run, server, scope);
  run.check("first command is the intended long command", /sleep 30/.test(command.params.item.command ?? ""));
  const result = await server.request("turn/steer", {
    threadId, expectedTurnId: scope.turnId,
    input: [text("Stop the remaining commands. Do not execute LAB_TWO or LAB_THREE. Reply with exactly: HELLO-STEER-3")],
  });
  run.check("native steer stayed in the same turn", result.turnId === scope.turnId);
  const turn = await terminalTurn(run, server, scope, "completed");
  run.check("steered response matches marker", messages(turn) === "HELLO-STEER-3");
  const commandItems = [
    ...(turn.items ?? []),
    ...server.events.filter((event) => event.threadId === threadId && event.turnId === scope.turnId && event.method === "item/started").map((event) => event.params.item),
  ];
  run.check("command absence evidence was not evicted", server.droppedEvents === 0);
  run.check("remaining commands did not start", !commandItems.some((item) => item?.type === "commandExecution" && /LAB_TWO|LAB_THREE/.test(item.command ?? "")));
  run.check("steer did not create another turn", server.events.filter((event) => event.method === "turn/started" && event.threadId === threadId && event.seq > scope.after).every((event) => event.turnId === scope.turnId));
}

async function x4(run, decision) {
  const policy = process.env.CODEX_LAB_POLICY ?? "untrusted";
  if (!["untrusted", "on-request"].includes(policy)) throw labError("APPROVAL_POLICY_NOT_SUPPORTED");
  const server = run.server();
  const threadId = await newThread(run, server, policy, "workspace-write");
  const filename = "approval-sample.txt";
  const commandText = "printf '%s' 'APPROVED-BY-PHONE' > 'approval-sample.txt'";
  const sample = join(run.cwd, filename);
  run.check("approval sample is absent in the fresh workspace", !existsSync(sample));
  const approvals = [];
  const approvalAfter = server.cursor;
  server.onServerRequest = (method, params) => {
    if (method !== "item/commandExecution/requestApproval") return undefined;
    run.check("approval belongs to the isolated thread", params.threadId === threadId);
    const started = server.events.find((event) => event.seq > approvalAfter && event.threadId === threadId && event.method === "turn/started");
    run.check("approval belongs to the initial active turn", started?.turnId === params.turnId && !server.events.some((event) => event.method === "turn/completed" && event.threadId === threadId && event.turnId === params.turnId));
    run.check("approval command is exactly the authorized sample write", params.command === commandText);
    run.check("approval cwd is the isolated workspace", params.cwd === run.cwd);
    approvals.push({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId });
    return { decision };
  };
  try {
    const scope = await startTurn(run, server, threadId,
      `Use exactly this one shell command in the current directory: ${commandText}. If approval is declined, reply BLOCKED and stop. Do not use a file-edit tool or any other command.`);
    const turn = await terminalTurn(run, server, scope, "completed");
    run.check("at least one command approval was received", approvals.length > 0);
    run.check("every approval belongs to this turn", approvals.every((approval) => approval.turnId === scope.turnId));
    if (decision === "accept") {
      run.check("accepted command created the sample", existsSync(sample));
      run.check("sample contains exactly the approved marker", readFileSync(sample, "utf8") === "APPROVED-BY-PHONE");
      run.check("approved command completed successfully", (turn.items ?? []).some((item) => item.type === "commandExecution" && item.status === "completed" && item.exitCode === 0));
    } else {
      run.check("declined command did not create a sample", !existsSync(sample));
      run.check("declined turn reports the blocked marker", messages(turn) === "BLOCKED");
    }
    run.artifact.approval = { decision, count: approvals.length, sampleExists: existsSync(sample) };
    await assertAlive(run, server, threadId, `ALIVE-AFTER-${decision.toUpperCase()}`);
  } finally { rmSync(sample, { force: true }); }
}

async function x5(run) {
  const server = run.server();
  const threadId = await newThread(run, server);
  const scope = await startTurn(run, server, threadId, "Run `sleep 90 && echo DONE-SLEEP` as a shell tool call, then reply FINISHED.");
  const command = await runningCommand(run, server, scope);
  run.check("interrupt targets the intended long command", /sleep 90/.test(command.params.item.command ?? ""));
  await server.request("turn/interrupt", { threadId, turnId: scope.turnId });
  const turn = await terminalTurn(run, server, scope, "interrupted");
  run.check("interrupt has no terminal error", !turn.error);
  await assertAlive(run, server, threadId, "ALIVE-X5");
}

async function x6(run) {
  const first = run.server("writer-A");
  const threadId = await newThread(run, first);
  const scope = await startTurn(run, first, threadId, "Run `sleep 90 && echo A-DONE` as a shell tool call, then reply FINISHED-A.");
  const command = await runningCommand(run, first, scope);
  run.check("writer test observed the intended long command", /sleep 90/.test(command.params.item.command ?? ""));
  const second = run.server("writer-B");
  await second.initialize();
  commandStillRunning(run, first, scope, command.itemId);
  let conflict = false;
  try { await second.request("thread/resume", { threadId, excludeTurns: true }); }
  catch (error) { conflict = error.rpcCode === -32600 && error.rpcReason === "active_writer"; }
  run.check("second self-owned process is rejected as an active writer", conflict);
  commandStillRunning(run, first, scope, command.itemId);
  // Do not turn/start from B if an old server incorrectly permits resume.
  await first.request("turn/interrupt", { threadId, turnId: scope.turnId });
  await terminalTurn(run, first, scope, "interrupted");
  run.artifact.writerScope = "two-self-owned-app-server-processes-only";
}

async function x7(run) {
  const server = run.server();
  const threadId = await newThread(run, server);
  const inputRequests = [];
  server.onServerRequest = (method, params) => {
    if (method !== "item/tool/requestUserInput") return undefined;
    run.check("question request belongs to this thread", params.threadId === threadId);
    inputRequests.push(params.turnId);
    return UNSUPPORTED; // Never choose an option or invent an answer on the user's behalf.
  };
  const scope = await startTurn(run, server, threadId,
    "Use request_user_input to ask whether I prefer TypeScript or JavaScript. If unavailable or unsupported, stop without choosing for me.");
  const turn = await terminalTurn(run, server, scope, "completed");
  run.check("user-input protocol was actually observed", inputRequests.length > 0);
  run.check("all user-input requests belong to this turn", inputRequests.every((turnId) => turnId === scope.turnId));
  run.check("no tools executed in place of the user's answer", !(turn.items ?? []).some((item) => item.type === "commandExecution" || item.type === "fileChange"));
  run.artifact.userInput = { observed: inputRequests.length, clientAnswer: "unsupported", capabilityVerified: inputRequests.length > 0 };
}

export const cases = { x2a, x2b, x3, x4accept: (run) => x4(run, "accept"), x4decline: (run) => x4(run, "decline"), x5, x6, x7 };

export async function main(argv = process.argv.slice(2)) {
  const name = argv[0];
  try {
    if (name === "--help") { console.log("Usage: node exp.mjs <x2a|x2b|x3|x4accept|x4decline|x5|x6|x7> --run [--thread <explicit-id>]\n--run permits a real model call; x2a may acquire a writer and change thread metadata."); return 0; }
    if (!cases[name]) throw labError("UNKNOWN_EXPERIMENT");
    const options = parseOptions(argv.slice(1), { experiment: true });
    if (options.help) { console.log("Every experiment requires --run; x2a also requires --thread <explicit-id>."); return 0; }
    if (name === "x2a" && !options.thread) throw labError("EXPLICIT_THREAD_REQUIRED");
    if (name !== "x2a" && options.thread) throw labError("THREAD_SELECTION_NOT_APPLICABLE");
    if (options.experimental || options.rollout) throw labError("INVALID_CLI_ARGUMENT");
    return await executeRun(name, (run) => cases[name](run, options));
  } catch (error) { return reportCliError(error); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
