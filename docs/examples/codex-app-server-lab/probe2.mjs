import { AppServer, sleep } from "./lab.mjs";
const as = new AppServer({ label: "probe2" }).start();
await as.request("initialize", { clientInfo: { name: "agent-hub-lab", title: "probe", version: "0.0.1" } }, 30000);
// 1) 可用模型清单
try {
  const m = await as.request("model/list", {}, 30000);
  const arr = m.models ?? m.data ?? m;
  console.log("MODEL-LIST keys:", Object.keys(m).join(","));
  console.log(JSON.stringify(arr).slice(0, 1200));
} catch (e) { console.log("MODEL-LIST-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0,300)); }
// 2) 认证状态
try { console.log("AUTH", JSON.stringify(await as.request("getAuthStatus", {}, 20000)).slice(0, 500)); }
catch (e) { console.log("AUTH-ERR", e.message); }
// 3) 会话 historyMode / cliVersion 分布 + 找一个可 resume 的
try {
  const list = await as.request("thread/list", { limit: 100 }, 60000);
  const d = list.data ?? [];
  console.log("THREADS:", d.length);
  const byMode = {};
  for (const t of d) { const k = `${t.historyMode ?? "?"}|${t.cliVersion ?? "?"}`; byMode[k] = (byMode[k] ?? 0) + 1; }
  console.log("historyMode|cliVersion 分布:", JSON.stringify(byMode, null, 1));
  console.log("status 分布:", JSON.stringify(d.reduce((a, t) => { const k = t.status?.type ?? "?"; a[k] = (a[k] ?? 0) + 1; return a; }, {})));
  const legacy = d.filter((t) => t.historyMode !== "paginated").slice(0, 3);
  console.log("非 paginated 候选:", JSON.stringify(legacy.map((t) => ({ id: t.id, mode: t.historyMode, cli: t.cliVersion, status: t.status?.type, cwd: t.cwd, updated: t.updatedAt })), null, 1));
  // 4) 逐个试 resume（非 paginated 优先，再试一个 paginated 确认错误码）
  for (const t of [...legacy.slice(0, 2), ...d.filter((x) => x.historyMode === "paginated").slice(0, 1)]) {
    try {
      const r = await as.request("thread/resume", { threadId: t.id }, 90000);
      console.log(`RESUME-OK id=${t.id} mode=${t.historyMode} → status=${JSON.stringify(r.thread?.status)} model=${r.model} approval=${r.approvalPolicy} sandbox=${JSON.stringify(r.sandbox).slice(0,120)}`);
      try { await as.request("thread/unsubscribe", { threadId: t.id }, 15000); } catch {}
    } catch (e) {
      console.log(`RESUME-ERR id=${t.id} mode=${t.historyMode} → ${e.message} ${JSON.stringify(e.rpc ?? {}).slice(0,200)}`);
    }
  }
} catch (e) { console.log("THREAD-LIST-ERR", e.message); }
await as.close();
process.exit(0);
