const ROLLOUT_JS = process.env.CODEX_ROLLOUT_JS ?? "../../../server/dist/adapters/codex-rollout.js";
const { loadCodexSessionMessages } = await import(new URL(ROLLOUT_JS, `file://${process.cwd()}/`).href);
import { readdirSync } from "node:fs";
// 用法: node parse-check.mjs [YYYY/MM/DD]（缺省今天）——体检自研解析器对新版 codex rollout 的兼容性
const day = process.argv[2] ?? new Date().toISOString().slice(0,10).split("-").join("/");
const dir = `${process.env.HOME}/.codex/sessions/${day}`;
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f}`);
console.log("rollout 目录:", dir, "文件数:", files.length);
for (const f of files.slice(-6)) {
  try {
    const msgs = await loadCodexSessionMessages(f);
    const roles = msgs.reduce((a, m) => { a[m.role] = (a[m.role] ?? 0) + 1; return a; }, {});
    const tools = msgs.flatMap((m) => (m.toolCalls ?? []).map((t) => t.name));
    console.log(`\n--- ${f.split("/").pop().slice(0, 60)}`);
    console.log(`  消息数=${msgs.length} roles=${JSON.stringify(roles)} 工具=${tools.join(",") || "(无)"}`);
    for (const m of msgs.slice(0, 4)) {
      console.log(`  [${m.role}] ${JSON.stringify(m.text ?? "").slice(0, 130)}`);
    }
  } catch (e) {
    console.log(`\n--- ${f.split("/").pop().slice(0, 60)}\n  PARSE-ERROR: ${e.message}`);
  }
}
