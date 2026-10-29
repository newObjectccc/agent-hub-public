/**
 * 会话驱动来源标注（心理预期管理）：
 * 手机/网页面板发消息 = server 进程的 pi SDK 实例驱动同一会话文件追加，
 * 电脑终端 pi 进程看不到（需 pi --resume 重开）。POST /api/sessions/:id/prompt
 * 成功时把会话记入「面板驱动过」集合（持久化 data/panel-driven.json，重启不丢）；
 * 集合只增不减（简化口径：驱动过即 lastDrivenBy=panel，claude 会话同理）。
 * 未驱动过面板的会话再按消息数分流：有实质消息 = 终端驱动过（terminal）；
 * 从未有任何消息（刚创建的空会话）= 无驱动史（不下发字段，前端不据此默认接管）。
 *
 * 纯函数（parse/serialize）可单测；文件 IO 收敛在 PanelDrivenStore 薄封装，
 * 保存失败静默（标注只是预期管理，绝不阻断发送主链路）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 驱动来源：面板（手机/网页）或终端（电脑 pi/claude 进程） */
export type SessionDrivenBy = "panel" | "terminal";

export const PANEL_DRIVEN_FILE = "panel-driven.json";

export interface PanelDrivenStoreLike {
  has(sessionId: string): boolean;
  mark(sessionId: string): Promise<void>;
}

interface StoredShape {
  version: 1;
  sessionIds: string[];
}

/** JSON → id 集合（损坏/缺字段一律回空集合，绝不 throw） */
export function parsePanelDriven(raw: string): Set<string> {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>;
    if (!parsed || !Array.isArray(parsed.sessionIds)) return new Set();
    return new Set(parsed.sessionIds.filter((id): id is string => typeof id === "string" && id !== ""));
  } catch {
    return new Set();
  }
}

/** id 集合 → JSON（排序稳定，便于 diff/备份） */
export function serializePanelDriven(ids: Iterable<string>): string {
  const stored: StoredShape = { version: 1, sessionIds: [...ids].sort() };
  return `${JSON.stringify(stored, null, 2)}\n`;
}

/** 驱动来源判定（纯函数）：
 * - 面板驱动过 → "panel"（持久集合只增不减）
 * - 有实质消息但未被面板驱动过 → "terminal"（消息是电脑终端写的）
 * - 从未有任何消息（刚创建的空会话）→ undefined（无驱动史，DTO 不下发字段）
 */
export function drivenByOf(
  store: Pick<PanelDrivenStoreLike, "has">,
  sessionId: string,
  messageCount: number,
): SessionDrivenBy | undefined {
  if (store.has(sessionId)) return "panel";
  return messageCount > 0 ? "terminal" : undefined;
}

/**
 * 持久化集合：构造时同步加载（文件很小，保证构造完 has() 即准确），
 * mark 后串行保存（失败静默：标注丢了只影响提示条，不阻断发送主链路）。
 */
export class PanelDrivenStore implements PanelDrivenStoreLike {
  private ids = new Set<string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    try {
      this.ids = parsePanelDriven(readFileSync(this.file, "utf8"));
    } catch {
      // 文件缺失/不可读/损坏：空集合起步
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  async mark(sessionId: string): Promise<void> {
    if (sessionId === "") return;
    if (this.ids.has(sessionId)) return;
    this.ids.add(sessionId);
    const snapshot = serializePanelDriven(this.ids);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, snapshot, "utf8");
      } catch {
        // 保存失败静默：标注丢了只影响提示条，不阻断发送
      }
    });
    await this.saving;
  }
}

export function createPanelDrivenStore(dataDir: string): PanelDrivenStore {
  return new PanelDrivenStore(join(dataDir, PANEL_DRIVEN_FILE));
}
