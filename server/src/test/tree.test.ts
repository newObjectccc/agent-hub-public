/**
 * 会话分支树单测：分叉 fixture 构树、先序 DFS、hasChildren、
 * activePath 计算、role/摘要映射、断链与 v1 线性文件防御。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSessionTree, entryRole, summarizeEntry, TREE_SUMMARY_LIMIT } from "../sessions/tree.js";
import type { RawEntry } from "../sessions/scan.js";

function line(entry: Record<string, unknown>): RawEntry {
  return JSON.parse(JSON.stringify(entry)) as RawEntry;
}

/** 分叉 fixture：e1 → e2 → e3（弃用），e1 → e4 → e5（活跃，leaf=e5） */
const forked: RawEntry[] = [
  line({ type: "message", id: "e1", parentId: null, timestamp: "2026-02-18T10:00:01.000Z", message: { role: "user", content: "帮我检查 KPI", timestamp: 1000 } }),
  line({
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-02-18T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "好的，先看口径" }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } }],
      timestamp: 2000,
    },
  }),
  line({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-02-18T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "total 0" }], isError: false, timestamp: 3000 },
  }),
  line({ type: "message", id: "e4", parentId: "e1", timestamp: "2026-02-18T10:05:00.000Z", message: { role: "user", content: "换个思路", timestamp: 4000 } }),
  line({ type: "message", id: "e5", parentId: "e4", timestamp: "2026-02-18T10:05:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "结论 98.2%" }], timestamp: 5000 } }),
];

describe("tree: buildSessionTree 分叉构树", () => {
  it("先序 DFS 输出，同级按 timestamp 升序，hasChildren 正确", () => {
    const tree = buildSessionTree(forked);
    assert.deepEqual(tree.entries.map((e) => e.id), ["e1", "e2", "e3", "e4", "e5"]);
    assert.deepEqual(
      tree.entries.map((e) => e.hasChildren),
      [true, true, false, true, false],
    );
    assert.deepEqual(tree.entries[3].parentId, "e1");
    assert.deepEqual(tree.entries.map((e) => e.role), ["user", "assistant", "toolResult", "user", "assistant"]);
  });

  it("activePath = 活跃分支 root→leaf（e1→e4→e5），弃用分支不在路径上", () => {
    const tree = buildSessionTree(forked);
    assert.deepEqual(tree.activePath, ["e1", "e4", "e5"]);
  });

  it("分叉点（e1）下两个子树都保留：弃用分支 e2/e3 仍可见", () => {
    const tree = buildSessionTree(forked);
    const byParent = new Map<string, string[]>();
    for (const e of tree.entries) {
      const key = e.parentId ?? "root";
      byParent.set(key, [...(byParent.get(key) ?? []), e.id]);
    }
    assert.deepEqual(byParent.get("e1"), ["e2", "e4"]);
  });

  it("多 root / 悬空 parentId 的节点视为根，不丢数据", () => {
    const entries: RawEntry[] = [
      ...forked,
      line({ type: "message", id: "x1", parentId: "missing-parent", timestamp: "2026-02-18T10:06:00.000Z", message: { role: "user", content: "孤儿节点", timestamp: 6000 } }),
    ];
    const tree = buildSessionTree(entries);
    assert.equal(tree.entries.length, 6);
    const x1 = tree.entries.find((e) => e.id === "x1");
    assert.equal(x1?.parentId, "missing-parent");
  });

  it("v1 线性文件（无 id/parentId）按顺序成链，activePath 覆盖全链", () => {
    const legacy: RawEntry[] = [
      line({ type: "message", timestamp: "2026-02-18T10:00:01.000Z", message: { role: "user", content: "第一句", timestamp: 1000 } }),
      line({ type: "message", timestamp: "2026-02-18T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "第二句" }], timestamp: 2000 } }),
    ];
    const tree = buildSessionTree(legacy);
    assert.deepEqual(tree.entries.map((e) => e.id), ["anon-0", "anon-1"]);
    assert.deepEqual(tree.activePath, ["anon-0", "anon-1"]);
  });
});

describe("tree: role 与摘要映射", () => {
  it("entryRole：message 取 message.role，custom_message→custom，其余→other", () => {
    assert.equal(entryRole(forked[0]), "user");
    assert.equal(entryRole(forked[2]), "toolResult");
    assert.equal(entryRole(line({ type: "custom_message", id: "c1", parentId: null, content: "hi" })), "custom");
    assert.equal(entryRole(line({ type: "model_change", id: "m1", parentId: null })), "other");
    assert.equal(entryRole(line({ type: "message", id: "s1", parentId: null, message: { role: "system", content: "" } })), "system");
    assert.equal(entryRole(line({ type: "message", id: "u1", parentId: null, message: { role: "weird" } })), "other");
  });

  it("摘要：文本截断到 TREE_SUMMARY_LIMIT；toolCall-only assistant 用 [tool] 占位", () => {
    const long = summarizeEntry(line({ type: "message", id: "l1", parentId: null, message: { role: "user", content: "x".repeat(200) } }));
    assert.equal(long.length, TREE_SUMMARY_LIMIT + 1);
    assert.ok(long.endsWith("…"));
    const toolOnly = summarizeEntry(
      line({ type: "message", id: "t1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "git status" } }] } }),
    );
    assert.equal(toolOnly, "[tool] git status");
  });

  it("摘要：compaction/branch_summary/model_change/usage 带类型前缀", () => {
    assert.ok(summarizeEntry(line({ type: "compaction", id: "x", parentId: null, summary: "abc" })).startsWith("[context compacted] abc"));
    assert.ok(summarizeEntry(line({ type: "branch_summary", id: "x", parentId: null, summary: "def" })).startsWith("[branch summary] def"));
    assert.equal(summarizeEntry(line({ type: "model_change", id: "x", parentId: null, provider: "openai", modelId: "gpt-4o" })), "[model] openai/gpt-4o");
    assert.equal(summarizeEntry(line({ type: "usage", id: "x", parentId: null, kind: "cache_warm" })), "[usage] cache_warm");
    assert.equal(summarizeEntry(line({ type: "weird_type", id: "x", parentId: null })), "[weird_type]");
  });
});
