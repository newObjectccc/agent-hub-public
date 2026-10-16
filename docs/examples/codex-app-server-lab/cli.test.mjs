import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun } from "./run.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(directory, "fixtures", "fake-server.mjs");
const secret = "SECRET_PROTOCOL_BODY_中文_123";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "codex-lab-cli-test-"));
  const binary = join(root, "fake-codex");
  // An executable Node fixture is the only binary the CLI can launch in these tests.
  copyFileSync(fixture, binary); chmodSync(binary, 0o700);
  let count = 0;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    run(script, args = [], env = {}) {
      const tracePath = join(root, `trace-${++count}.jsonl`);
      const result = spawnSync(process.execPath, [join(directory, script), ...args], {
        cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, CODEX_LAB_BIN: binary, CODEX_LAB_DIR: join(root, "lab"), CODEX_LAB_WS: "", CODEX_LAB_ARGS: "", CODEX_LAB_LOAD_SHELL_ENV: "0", CODEX_LAB_TIMEOUT_MS: "5000", CODEX_LAB_FAKE_MODE: "normal", CODEX_LAB_FAKE_TRACE: tracePath, ...env },
      });
      assert.equal(result.error, undefined);
      const output = result.stdout + result.stderr;
      assert(!output.includes(secret), "stdout/stderr must not expose protocol contents");
      const summary = result.stdout.trim().split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).findLast((item) => item?.artifact);
      const artifact = summary ? JSON.parse(readFileSync(summary.artifact, "utf8")) : null;
      if (artifact) {
        assert(!JSON.stringify(artifact).includes(secret));
        assert(!JSON.stringify(artifact).includes("authToken"));
      }
      const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split("\n").map(JSON.parse) : [];
      return { ...result, output, artifact, artifactPath: summary?.artifact, trace };
    },
  };
}

for (const script of ["probe2.mjs", "probe5.mjs", "probe6.mjs"]) {
  test(`${script} defaults to version/account/models/list without resume or turn`, (t) => {
    const result = setup(t).run(script);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.artifact.status, "passed");
    assert.deepEqual(result.trace.map((message) => message.method), ["--version", "initialize", "initialized", "model/list", "account/read", "thread/list"]);
    assert.equal(result.artifact.accountMode, "chatgpt");
    assert.equal(result.artifact.threads.count, 1);
    assert(!JSON.stringify(result.artifact).includes("private-never-resume"));
  });
}

test("legacy account probe requests no token and emits only account mode", (t) => {
  const result = setup(t).run("probe2.mjs", [], { CODEX_LAB_FAKE_MODE: "legacy-account" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.trace.find((message) => message.method === "getAuthStatus").params, { includeToken: false, refreshToken: false });
  assert.equal(result.artifact.accountMode, "chatgpt");
});

test("probe6 experimental capabilities require explicit flag", (t) => {
  const result = setup(t).run("probe6.mjs", ["--experimental"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.trace.find((message) => message.method === "initialize").params.capabilities, { experimentalApi: true });
  assert.deepEqual(result.artifact.experimentalCapabilities, { "experimentalFeature/list": "available", "permissionProfile/list": "available" });
  assert(!result.trace.some((message) => message.method === "thread/resume" || message.method === "turn/start"));
});

test("missing --run, missing explicit thread, invalid args and help cannot spawn Codex", (t) => {
  const cli = setup(t);
  for (const [args, expected] of [ [["x2b"], 2], [["x2a", "--run"], 2], [["x2a", "--thread", "explicit-test-thread"], 2], [["x2b", "--run", "--unknown"], 2], [["--help"], 0] ]) {
    const result = cli.run("exp.mjs", args);
    assert.equal(result.status, expected, result.output);
    assert.equal(result.trace.length, 0);
    assert.equal(result.artifact, null);
  }
});

for (const name of ["x2b", "x3", "x4accept", "x4decline", "x5", "x6", "x7"]) {
  test(`${name} asserts its scoped fake lifecycle and writes a safe artifact`, (t) => {
    const result = setup(t).run("exp.mjs", [name, "--run"]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.artifact.status, "passed");
    assert(result.artifact.checks.length > 3);
    assert(result.artifact.checks.every((check) => check.passed));
    assert(result.artifact.turns.length > 0);
    assert(!result.trace.some((message) => message.method === "thread/list"));
    if (name === "x3") {
      const steer = result.trace.find((message) => message.method === "turn/steer");
      assert.equal(steer.params.expectedTurnId, result.artifact.turns[0].turnId);
      assert.equal(result.trace.filter((message) => message.method === "turn/start").length, 1);
    }
    if (name === "x6") {
      assert.equal(result.trace.filter((message) => message.method === "turn/start").length, 1);
      assert.equal(result.artifact.writerScope, "two-self-owned-app-server-processes-only");
    }
    if (name === "x7") {
      const reply = result.trace.find((message) => message.id === "question-1" && !message.method);
      assert.equal(reply.error.code, -32601);
      assert.equal(reply.result, undefined);
    }
    if (["x4accept", "x4decline", "x5"].includes(name)) assert.equal(result.artifact.turns.length, 2, "follow-up must reach terminal, not merely inProgress");
  });
}

test("resume touches only the explicitly selected test thread", (t) => {
  const result = setup(t).run("exp.mjs", ["x2a", "--run", "--thread", "explicit-test-thread"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.trace.find((message) => message.method === "thread/resume").params, { threadId: "explicit-test-thread", excludeTurns: true });
  assert(!result.trace.some((message) => message.method === "thread/list" || message.method === "turn/start"));
});

test("completion before turn/start response is preserved with the captured cursor", (t) => {
  const result = setup(t).run("exp.mjs", ["x2b", "--run"], { CODEX_LAB_FAKE_MODE: "early-completion" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.artifact.turns[0].status, "completed");
});

test("wrong thread/turn terminal events cannot satisfy the experiment", (t) => {
  const result = setup(t).run("exp.mjs", ["x2b", "--run"], { CODEX_LAB_FAKE_MODE: "wrong-events" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.artifact.turns[0].turnId, "lab-turn-1");
});

test("retryable error notification does not settle a turn before completion", (t) => {
  const result = setup(t).run("exp.mjs", ["x2b", "--run"], { CODEX_LAB_FAKE_MODE: "retry-error" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.artifact.turns[0].status, "completed");
  assert(result.artifact.processes[0].events.some((event) => event.method === "error" && event.willRetry === true));
});

for (const [mode, codes] of [["unknown-request", ["UNKNOWN_SERVER_REQUEST"]], ["unknown-with-completion", ["UNKNOWN_SERVER_REQUEST"]], ["hang-turn", ["WAIT_TIMEOUT", "REQUEST_TIMEOUT"]]]) {
  test(`CLI ${mode} is a nonzero failure with a machine artifact`, (t) => {
    const result = setup(t).run("exp.mjs", ["x2b", "--run"], { CODEX_LAB_FAKE_MODE: mode, CODEX_LAB_TIMEOUT_MS: "1000" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.artifact.status, "failed");
    assert(codes.includes(result.artifact.error.code));
  });
}

for (const [name, mode, failedCheck] of [
  ["x2b", "failed-turn", "turn reached expected terminal status"],
  ["x5", "no-command", "observed command start before turn finished"],
  ["x3", "steer-new-turn", "native steer stayed in the same turn"],
  ["x6", "allow-writer", "second self-owned process is rejected as an active writer"],
  ["x4decline", "decline-writes", "declined command did not create a sample"],
  ["x4accept", "unsafe-approval", "approval command is exactly the authorized sample write"],
  ["x4accept", "wrong-approval-turn", "approval belongs to the initial active turn"],
  ["x7", "no-question", "user-input protocol was actually observed"],
]) {
  test(`${name} exits nonzero for ${mode} rather than reporting success`, (t) => {
    const result = setup(t).run("exp.mjs", [name, "--run"], { CODEX_LAB_FAKE_MODE: mode });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.artifact.status, "failed");
    assert(result.artifact.checks.some((check) => check.name === failedCheck && check.passed === false));
    if (mode === "allow-writer") assert.equal(result.trace.filter((message) => message.method === "turn/start").length, 1);
  });
}

test("repeated accept/decline runs use distinct workspaces and remove samples", (t) => {
  const cli = setup(t);
  const artifacts = [];
  const workspaces = [];
  for (const name of ["x4accept", "x4decline", "x4accept", "x4decline"]) {
    const result = cli.run("exp.mjs", [name, "--run"]);
    assert.equal(result.status, 0, result.output);
    artifacts.push(result.artifactPath);
    const cwd = result.trace.find((message) => message.method === "thread/start").params.cwd;
    workspaces.push(cwd);
    assert(!existsSync(join(cwd, "approval-sample.txt")));
    assert.equal(result.artifact.approval.sampleExists, name === "x4accept");
  }
  assert.equal(new Set(artifacts).size, 4);
  assert.equal(new Set(workspaces).size, 4);
});

test("custom lab/workspace roots are respected without hardcoded output paths", (t) => {
  const cli = setup(t);
  const base = join(cli.root, "custom-lab");
  const workspace = join(base, "custom-workspaces");
  const result = cli.run("exp.mjs", ["x2b", "--run"], { CODEX_LAB_DIR: base, CODEX_LAB_WS: workspace });
  assert.equal(result.status, 0, result.output);
  const cwd = result.trace.find((message) => message.method === "thread/start").params.cwd;
  assert(!relative(realpathSync(base), result.artifactPath).startsWith(".."));
  assert(!relative(realpathSync(workspace), cwd).startsWith(".."));
  assert.notEqual(cwd, realpathSync(workspace));
});

test("a project checkout cannot become the lab sandbox", () => {
  assert.throws(() => createRun("reject-project", { CODEX_LAB_DIR: directory }), { code: "TEMP_DIRECTORY_REQUIRED" });
});

test("parse-check requires one explicit rollout and never scans private history", (t) => {
  const cli = setup(t);
  const missing = cli.run("parse-check.mjs");
  assert.equal(missing.status, 2); assert.equal(missing.trace.length, 0);
  const selected = join(cli.root, "selected.jsonl");
  const parser = join(cli.root, "parser.mjs");
  writeFileSync(selected, "{\"fake\":true}\n");
  writeFileSync(parser, `export async function loadCodexSessionMessages(){return [{role:'user',text:${JSON.stringify(secret)}},{role:'assistant',text:${JSON.stringify(secret)},toolCalls:[{name:'unknown'}]}]}`);
  const result = cli.run("parse-check.mjs", ["--rollout", selected], { CODEX_ROLLOUT_JS: parser });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.trace.length, 0);
  assert.deepEqual(result.artifact.messages, { count: 2, user: 1, assistant: 1, tools: 1, unknownTools: 1, emptyAssistant: 0 });
});
