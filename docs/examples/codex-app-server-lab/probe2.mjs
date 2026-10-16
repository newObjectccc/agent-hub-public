import { executeRun, parseOptions, readOnlyProbe, reportCliError } from "./run.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log("Usage: node probe2.mjs\nRead-only version/account mode/models/thread list. Never resumes or starts a turn.");
  else if (Object.keys(options).length) process.exitCode = reportCliError({ code: "INVALID_CLI_ARGUMENT" });
  else process.exitCode = await executeRun("probe2", (run) => readOnlyProbe(run));
} catch (error) { process.exitCode = reportCliError(error); }
