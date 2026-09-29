import { useState } from "react";
import { api } from "../api/client";
import type { SessionSummary } from "../api/types";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";

export interface NewSessionFormProps {
  onCreated: (session: SessionSummary) => void;
}

/** 新建会话：cwd 文本输入（必填）+ name（可选）→ POST /api/sessions */
export function NewSessionForm({ onCreated }: NewSessionFormProps) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError("请填写工作目录（cwd）绝对路径");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.createSession(trimmed, name.trim() || undefined);
      setCwd("");
      setName("");
      setOpen(false);
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        + 新建会话
      </Button>
    );
  }

  return (
    <Card className="card form-card">
      <Input
        placeholder="工作目录 cwd（绝对路径，如 /Users/me/Workspace/proj）"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        aria-label="工作目录"
      />
      <div className="form-row">
        <Input
          placeholder="会话名称（可选）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="会话名称"
        />
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <Button type="button" onClick={submit} disabled={busy}>
          {busy ? "创建中…" : "创建"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
        >
          取消
        </Button>
      </div>
    </Card>
  );
}
