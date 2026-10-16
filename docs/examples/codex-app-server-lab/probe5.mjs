import { AppServer, text } from "./lab.mjs";
import { loadShellProviderEnv } from "./env.mjs";
const BIN = process.env.CODEX_LAB_BIN ?? "codex";  // 例：ChatGPT.app 内嵌 codex（0.162）
const as = new AppServer({ label: "v162", env: loadShellProviderEnv(), bin: BIN }).start();
await as.request("initialize", { clientInfo: { name: "agent-hub-lab", title: "probe-0.162", version: "0.0.1" } }, 40000);
console.log("AUTH:", JSON.stringify(await as.request("getAuthStatus", {}, 20000)).slice(0, 200));
const m = await as.request("model/list", {}, 30000).catch((e) => ({ err: e.message }));
console.log("MODELS:", (m.data ?? []).map((x) => x.id).join(", ") || JSON.stringify(m).slice(0, 200));
let all = [], cursor = null, g = 0;
do { const l = await as.request("thread/list", { limit: 50, ...(cursor ? { cursor } : {}) }, 60000); all.push(...(l.data ?? [])); cursor = l.nextCursor ?? null; } while (cursor && g++ < 10);
console.log("THREADS-TOTAL:", all.length, "| historyMode:", JSON.stringify(all.reduce((a, t) => { a[t.historyMode ?? "?"] = (a[t.historyMode ?? "?"] ?? 0) + 1; return a; }, {})));
const pag = all.find((t) => t.historyMode === "paginated");
if (pag) {
  try { const r = await as.request("thread/resume", { threadId: pag.id }, 120000);
    console.log(`RESUME-PAGINATED-OK id=${pag.id.slice(-8)} cli=${pag.cliVersion} → status=${JSON.stringify(r.thread?.status)} model=${r.model} approval=${r.approvalPolicy}`);
    await as.request("thread/unsubscribe", { threadId: pag.id }, 15000).catch(() => {});
  } catch (e) { console.log("RESUME-PAGINATED-ERR:", e.message, JSON.stringify(e.rpc ?? {}).slice(0, 200)); }
}
// 真 turn（沙箱新 thread）
const st = await as.request("thread/start", { cwd: "/tmp/codex-lab/ws", sandbox: "workspace-write", approvalPolicy: "never" }, 90000);
console.log("THREAD-START:", st.thread.id, "model:", st.model, "rollout:", st.thread.path);
const done = as.waitFor((e) => e.method === "turn/completed", 180000, "turn/completed");
const r = await as.request("turn/start", { threadId: st.thread.id, input: [text("Reply with exactly: PONG-162. Do not call any tools.")], effort: "low" }, 180000);
console.log("TURN:", r.turn?.id, r.turn?.status);
const c = await done;
console.log("COMPLETED:", c?.params?.turn?.status, "err:", JSON.stringify(c?.params?.turn?.error ?? null).slice(0, 260));
console.log("AGENT-TEXT:", JSON.stringify((c?.params?.turn?.items ?? []).filter((i) => i.type === "agentMessage").map((i) => i.text)).slice(0, 200));
console.log("ITEM-TYPES:", (c?.params?.turn?.items ?? []).map((i) => i.type).join(","));
await as.close();
process.exit(0);
