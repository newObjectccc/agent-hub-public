/**
 * 重命名会话（移动端 bottom sheet / 大屏居中弹窗，容器样式由 Sheet + CSS 断点决定）：
 * - 当前名预填；清空提交 = 去掉名字
 * - 保存 → api.renameSession（错误信封归一为 ApiError，提示内联展示）→ onRenamed 回调
 *   （页头/列表立即刷新由调用方负责，server 端已 invalidateList）
 */
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionSummary } from "../api/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet } from "./Sheet";

export interface RenameSessionSheetProps {
  open: boolean;
  sessionId: string;
  /** 当前会话名（预填；null/空 = 无名字） */
  currentName?: string | null;
  onClose: () => void;
  /** 保存成功（server 返回更新后的会话项），调用方负责刷新与关闭 */
  onRenamed: (session: SessionSummary) => void;
}

export function RenameSessionSheet({ open, sessionId, currentName, onClose, onRenamed }: RenameSessionSheetProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时预填当前名（每次打开都从最新 props 取，避免残留上次编辑）
  useEffect(() => {
    if (open) {
      setName(currentName ?? "");
      setError(null);
    }
  }, [open, currentName]);

  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.renameSession(sessionId, name.trim());
      onRenamed(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Sheet
      title="重命名会话"
      subtitle="改个好认的名字，列表里一眼找到（留空并保存 = 去掉名字）"
      onClose={close}
      footer={
        <div className="form-row">
          <Button type="button" onClick={() => void submit()} disabled={busy} className="flex-1">
            {busy ? "保存中…" : "保存"}
          </Button>
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <div className="field">
        <div className="field-label">会话名称</div>
        <Input
          placeholder="如：KPI 周报（留空 = 去掉名字）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="会话名称"
          maxLength={200}
          inputMode="text"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </Sheet>
  );
}
