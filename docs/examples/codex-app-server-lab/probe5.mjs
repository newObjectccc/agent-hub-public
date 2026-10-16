// Kept as the binary-comparison entry point. It has the same read-only scope as probe2.
import { executeRun, parseOptions, readOnlyProbe, reportCliError } from "./run.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log("Usage: CODEX_LAB_BIN=/path/to/codex node probe5.mjs\nRead-only binary comparison; real turns moved to exp.mjs x2b --run.");
  else if (Object.keys(options).length) process.exitCode = reportCliError({ code: "INVALID_CLI_ARGUMENT" });
  else process.exitCode = await executeRun("probe5", (run) => readOnlyProbe(run));
} catch (error) { process.exitCode = reportCliError(error); }
