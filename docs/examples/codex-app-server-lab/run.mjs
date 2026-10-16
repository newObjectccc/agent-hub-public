/** Common CLI lifecycle: opt-in mutations, isolated cwd, safe JSON evidence, always close. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { AppServer, labError, safeError } from "./lab.mjs";
import { childEnv } from "./env.mjs";

export function parseOptions(argv, { experiment = false } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (["--run", "--experimental", "--help"].includes(option)) options[option.slice(2)] = true;
    else if (["--thread", "--rollout"].includes(option) && argv[i + 1] && !argv[i + 1].startsWith("--")) options[option.slice(2)] = argv[++i];
    else throw labError("INVALID_CLI_ARGUMENT");
  }
  if (experiment && !options.run && !options.help) throw labError("EXPLICIT_RUN_REQUIRED");
  return options;
}

const within = (root, path) => { const rest = relative(root, path); return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest)); };
function temporaryRoot(value) {
  const path = resolve(value);
  let ancestor = path;
  while (true) {
    try {
      const actual = realpathSync(ancestor);
      const roots = [tmpdir(), "/tmp"].map((root) => realpathSync(root));
      if (!roots.some((root) => within(root, actual))) throw labError("TEMP_DIRECTORY_REQUIRED");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) throw labError("TEMP_DIRECTORY_REQUIRED");
      ancestor = parent;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

export function createRun(name, env = process.env) {
  const base = temporaryRoot(env.CODEX_LAB_DIR ?? join(tmpdir(), "agent-hub-codex-lab"));
  const workspaceBase = env.CODEX_LAB_WS ? temporaryRoot(env.CODEX_LAB_WS) : null;
  if (workspaceBase && !within(base, workspaceBase)) throw labError("WORKSPACE_OUTSIDE_LAB");
  const directory = mkdtempSync(join(base, `${name}-`));
  const cwd = workspaceBase ? mkdtempSync(join(workspaceBase, `${name}-`)) : join(directory, "ws");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const timeoutMs = env.CODEX_LAB_TIMEOUT_MS ? Number(env.CODEX_LAB_TIMEOUT_MS) : 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 600_000) throw labError("INVALID_TIMEOUT");
  if (env.CODEX_LAB_ARGS) throw labError("UNSUPPORTED_ARGS_OVERRIDE");
  const servers = [];
  const checks = [];
  const artifact = { schemaVersion: 1, case: name, startedAt: new Date().toISOString(), status: "running", checks };
  return {
    directory, cwd, timeoutMs, artifact, servers,
    check(name, condition) { checks.push({ name, passed: Boolean(condition) }); assert(condition, name); },
    server(label = name) {
      const server = new AppServer({ label, cwd, env: childEnv(env), bin: env.CODEX_LAB_BIN ?? "codex", limits: { requestMs: timeoutMs } });
      servers.push(server);
      return server.start();
    },
  };
}

export async function executeRun(name, action, { env = process.env } = {}) {
  let run;
  let failure;
  try {
    run = createRun(name, env);
    await action(run);
    for (const server of run.servers) { await server.settleHandlers(); server.assertHealthy(); }
  } catch (error) { failure = error; }
  finally {
    if (run) {
      run.artifact.processes = run.servers.map((server) => ({
        events: server.timeline(), unsupportedRequests: server.unsupportedRequests,
        stderrBytes: server.stderrBytes, droppedEvents: server.droppedEvents,
        ...(server.failure ? { failure: safeError(server.failure) } : {}),
      }));
      for (const server of [...run.servers].reverse()) {
        try { await server.close(); } catch (error) { failure ??= error; }
      }
      run.artifact.status = failure ? "failed" : "passed";
      run.artifact.finishedAt = new Date().toISOString();
      if (failure) run.artifact.error = safeError(failure);
      writeFileSync(join(run.directory, "result.json"), JSON.stringify(run.artifact, null, 2) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ status: run.artifact.status, artifact: join(run.directory, "result.json") }));
    } else console.error(JSON.stringify({ status: "failed", error: safeError(failure) }));
  }
  return failure ? 1 : 0;
}

export function reportCliError(error) {
  console.error(JSON.stringify({ status: "failed", error: safeError(error) }));
  return 2;
}

export function binaryVersion(run, env = process.env) {
  const result = spawnSync(env.CODEX_LAB_BIN ?? "codex", ["--version"], {
    cwd: run.cwd, env: childEnv(env), encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) throw labError("VERSION_FAILED");
  const version = result.stdout.trim();
  if (!/^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw labError("VERSION_RESPONSE_INVALID");
  run.artifact.binaryVersion = version;
  run.check("binary version is structured", true);
}

export async function readOnlyProbe(run, options = {}) {
  binaryVersion(run);
  const server = run.server();
  await server.initialize({ experimentalApi: options.experimental === true });
  run.check("initialize followed by initialized", true);
  const models = await server.request("model/list", {});
  const list = models.data ?? models.models;
  run.check("model list has an array", Array.isArray(list));
  run.artifact.modelCount = list.length;
  run.artifact.models = list.map((model) => model.id).filter((model) => /^(?:gpt-|o[1-9]|codex-)[a-z0-9_.-]{1,64}$/.test(model));
  // account/read does not expose a token and refreshToken:false avoids a refresh side effect.
  let account;
  try { account = await server.request("account/read", { refreshToken: false }); }
  catch (error) {
    if (error.rpcCode !== -32601) throw error;
    account = await server.request("getAuthStatus", { includeToken: false, refreshToken: false });
  }
  const mode = account.account?.type ?? account.authMethod ?? account.authMode ?? null;
  run.artifact.accountMode = ["chatgpt", "apiKey", "apikey", "chatgptAuthTokens"].includes(mode) ? mode : "unknown-or-signed-out";
  run.check("account response reduced to mode only", true);
  let cursor;
  let pages = 0;
  let count = 0;
  const seen = new Set();
  const modes = { legacy: 0, paginated: 0, unknown: 0 };
  do {
    const result = await server.request("thread/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    run.check(`thread list page ${pages + 1} is an array`, Array.isArray(result.data));
    count += result.data.length;
    for (const thread of result.data) modes[["legacy", "paginated"].includes(thread.historyMode) ? thread.historyMode : "unknown"] += 1;
    cursor = result.nextCursor ?? null;
    run.check("thread pagination does not loop", !cursor || !seen.has(cursor));
    if (cursor) seen.add(cursor);
    pages += 1;
  } while (cursor && pages < 20);
  run.check("thread listing reached its end", !cursor);
  run.artifact.threads = { count, pages, historyModes: modes };
  if (options.experimental) {
    run.artifact.experimentalCapabilities = {};
    for (const method of ["experimentalFeature/list", "permissionProfile/list"]) {
      try {
        await server.request(method, {});
        run.artifact.experimentalCapabilities[method] = "available";
      } catch (error) {
        if (error.rpcCode !== -32601) throw error;
        run.artifact.experimentalCapabilities[method] = "unsupported";
      }
    }
  }
}
