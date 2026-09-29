/**
 * 会话分支树（docs/API_CONTRACT.md §1.7）：
 * 从 JSONL entry 的 id/parentId 构树（pi /tree 语义），先序 DFS 输出，
 * 附 activePath（当前活跃分支 root→leaf 的 id 路径）。
 *
 * 全部 entry（含 toolResult/usage 等）都进树——它们是真实的树节点，
 * 跳过会断开父子链，让分叉点失真。
 */
import type { SessionTreeDto, TreeRole, TreeNodeDto } from "../types.js";
import {
  contentToText,
  parseSessionJsonl,
  readSessionFile,
  selectActiveBranch,
  summarizeToolCall,
  truncateText,
  type RawEntry,
} from "./scan.js";

/** 节点摘要截断长度 */
export const TREE_SUMMARY_LIMIT = 80;

interface NormalizedNode {
  id: string;
  parentId: string | null;
  role: TreeRole;
  text: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** entry → 树节点 role */
export function entryRole(entry: RawEntry): TreeRole {
  if (entry.type === "message") {
    const message = entry.message;
    if (isRecord(message) && typeof message.role === "string") {
      switch (message.role) {
        case "user":
        case "assistant":
        case "toolResult":
        case "custom":
        case "system":
          return message.role;
        default:
          return "other";
      }
    }
    return "other";
  }
  if (entry.type === "custom_message") return "custom";
  return "other";
}

/** entry → 节点摘要文本（TREE_SUMMARY_LIMIT 截断） */
export function summarizeEntry(entry: RawEntry): string {
  const summarize = (text: string): string => truncateText(text, TREE_SUMMARY_LIMIT);
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!isRecord(message)) return "";
      const text = summarize(contentToText(message.content));
      if (text !== "") return text;
      // assistant 只有 toolCall 无文本 → 用工具摘要占位
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "toolCall") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            return summarize(`[tool] ${summarizeToolCall(name, block.arguments)}`);
          }
        }
      }
      return "";
    }
    case "custom_message":
      return summarize(contentToText(entry.content));
    case "compaction":
      return summarize(`[context compacted] ${typeof entry.summary === "string" ? entry.summary : ""}`);
    case "branch_summary":
      return summarize(`[branch summary] ${typeof entry.summary === "string" ? entry.summary : ""}`);
    case "session_info":
      return summarize(`[session] ${typeof entry.name === "string" ? entry.name : ""}`);
    case "model_change": {
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const model = typeof entry.modelId === "string" ? entry.modelId : "";
      return summarize(`[model] ${provider}/${model}`);
    }
    case "thinking_level_change":
      return summarize(`[thinking] ${typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : ""}`);
    case "usage":
      return summarize(`[usage] ${typeof entry.kind === "string" ? entry.kind : ""}`);
    default:
      return `[${entry.type}]`;
  }
}

function entryTimestampMs(entry: RawEntry): number {
  const message = entry.message;
  if (isRecord(message) && typeof message.timestamp === "number") return message.timestamp;
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/**
 * 归一化：补 id（v1 线性文件缺 id/parentId 时按顺序成链）、补时间戳。
 * 显式 parentId 保留原样（含悬空引用，由构树阶段按根处理）。
 */
function normalize(entries: RawEntry[]): NormalizedNode[] {
  const nodes: NormalizedNode[] = [];
  let prevId: string | null = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const hasId = typeof entry.id === "string" && entry.id !== "";
    const id = hasId ? (entry.id as string) : `anon-${i}`;
    const hasParentField = "parentId" in entry;
    const parentId = hasParentField
      ? typeof entry.parentId === "string" && entry.parentId !== ""
        ? entry.parentId
        : null
      : prevId;
    nodes.push({
      id,
      parentId,
      role: entryRole(entry),
      text: summarizeEntry(entry),
      timestamp: entryTimestampMs(entry),
    });
    prevId = id;
  }
  return nodes;
}

/**
 * 构树：先序 DFS（同级按 timestamp 升序、再按文件顺序）。
 * 悬空 parentId 的节点视为根（文件损坏防御，不让孤儿遮蔽全树）。
 */
export function buildSessionTree(entries: RawEntry[]): SessionTreeDto {
  const nodes = normalize(entries);
  const byId = new Map<string, NormalizedNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  const children = new Map<string, NormalizedNode[]>();
  const roots: NormalizedNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId !== null ? byId.get(node.parentId) : undefined;
    if (!parent || parent.id === node.id) {
      roots.push(node);
      continue;
    }
    const bucket = children.get(parent.id) ?? [];
    bucket.push(node);
    children.set(parent.id, bucket);
  }
  const sorter = (a: NormalizedNode, b: NormalizedNode): number => a.timestamp - b.timestamp || 0;
  roots.sort(sorter);
  for (const bucket of children.values()) bucket.sort(sorter);

  // 先序 DFS（环保护：已访问节点不再展开）
  const out: TreeNodeDto[] = [];
  const visited = new Set<string>();
  const walk = (node: NormalizedNode): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const kids = children.get(node.id) ?? [];
    out.push({
      id: node.id,
      parentId: node.parentId,
      role: node.role,
      text: node.text,
      timestamp: node.timestamp,
      hasChildren: kids.length > 0,
    });
    for (const kid of kids) walk(kid);
  };
  for (const root of roots) walk(root);
  // 环内未到达的节点按文件顺序兜底追加，保证不丢数据
  for (const node of nodes) {
    if (!visited.has(node.id)) walk(node);
  }

  // activePath：活跃叶到根的路径（root→leaf），复用 selectActiveBranch 的环/断链保护
  const normalizedEntries: RawEntry[] = nodes.map((n) => ({
    type: "message",
    id: n.id,
    parentId: n.parentId,
    timestamp: new Date(n.timestamp).toISOString(),
  }));
  const activePath = selectActiveBranch(normalizedEntries)
    .map((e) => (typeof e.id === "string" ? e.id : ""))
    .filter((id) => id !== "");

  return { entries: out, activePath };
}

/** 读文件 → 分支树 */
export async function loadSessionTree(file: string): Promise<SessionTreeDto> {
  const parsed = parseSessionJsonl(await readSessionFile(file));
  return buildSessionTree(parsed.entries);
}
