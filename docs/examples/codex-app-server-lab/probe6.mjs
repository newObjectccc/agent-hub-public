import { executeRun, parseOptions, readOnlyProbe, reportCliError } from "./run.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log("Usage: node probe6.mjs [--experimental]\nRead-only probe; --experimental opts into experimentalApi and capability-list methods.");
  else if (Object.keys(options).some((key) => key !== "experimental")) process.exitCode = reportCliError({ code: "INVALID_CLI_ARGUMENT" });
  else process.exitCode = await executeRun("probe6", (run) => readOnlyProbe(run, options));
} catch (error) { process.exitCode = reportCliError(error); }
