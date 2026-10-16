import { AppServer } from "./lab.mjs";
const BIN = process.env.CODEX_LAB_BIN ?? "codex";  // 例：ChatGPT.app 内嵌 codex（0.162）
const as = new AppServer({ label: "feat", bin: BIN }).start();
await as.request("initialize", { clientInfo: { name: "agent-hub-lab", title: "probe", version: "0.0.1" } }, 40000);
try { const f = await as.request("experimentalFeature/list", {}, 30000);
  const arr = f.data ?? f.features ?? f;
  console.log("FEATURES:", JSON.stringify(arr).slice(0, 1500));
} catch (e) { console.log("FEATURES-ERR", e.message, JSON.stringify(e.rpc ?? {}).slice(0,200)); }
try { const p = await as.request("permissionProfile/list", {}, 30000); console.log("PERMISSION-PROFILES:", JSON.stringify(p).slice(0, 700)); }
catch (e) { console.log("PERMISSION-PROFILES-ERR", e.message); }
// 0.162 是否有 turns/items 分页方法
for (const m of ["thread/turns/list", "thread/items/list"]) {
  try { await as.request(m, { threadId: "00000000-0000-0000-0000-000000000000" }, 15000); console.log(m, "EXISTS (no error)"); }
  catch (e) { console.log(m, "→", e.message.slice(0, 110), JSON.stringify(e.rpc?.code ?? "")); }
}
await as.close();
process.exit(0);
