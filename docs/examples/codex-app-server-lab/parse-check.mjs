/** Explicit file only: never scans the user's session history or prints message bodies. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import { executeRun, parseOptions, reportCliError } from "./run.mjs";
import { labError } from "./lab.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log("Usage: node parse-check.mjs --rollout /explicit/path/to/lab-rollout.jsonl\nReads only the selected file; requires the server's built rollout parser.");
  else {
    if (!options.rollout || Object.keys(options).some((key) => key !== "rollout")) throw labError("EXPLICIT_ROLLOUT_REQUIRED");
    process.exitCode = await executeRun("parse-check", async (run) => {
      const file = resolve(options.rollout);
      run.check("selected rollout is a nonempty file", statSync(file).isFile() && statSync(file).size > 0);
      const parser = process.env.CODEX_ROLLOUT_JS ? pathToFileURL(resolve(process.env.CODEX_ROLLOUT_JS)) : new URL("../../../server/dist/adapters/codex-rollout.js", import.meta.url);
      const { loadCodexSessionMessages } = await import(parser.href);
      const messages = await loadCodexSessionMessages(file);
      run.check("rollout parser produced messages", Array.isArray(messages) && messages.length > 0);
      run.artifact.messages = { count: messages.length,
        user: messages.filter((message) => message.role === "user").length,
        assistant: messages.filter((message) => message.role === "assistant").length,
        tools: messages.reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0),
        unknownTools: messages.flatMap((message) => message.toolCalls ?? []).filter((tool) => tool.name === "unknown").length,
        emptyAssistant: messages.filter((message) => message.role === "assistant" && !(message.text ?? "").trim() && !message.toolCalls?.length).length,
      };
    });
  }
} catch (error) { process.exitCode = reportCliError(error); }
