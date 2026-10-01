/**
 * 设置页「应用锁」区块（F1）：改 PIN/口令、关闭锁、启用生物识别、立即锁定。
 * 除"设置并启用"外均需验证旧 PIN（防拿到手机直接关锁）。
 */
import { useState } from "react";
import { useAppLock } from "../hooks/useAppLock";
import { Button } from "./ui/button";

export function AppLockSettings() {
  const lock = useAppLock();
  const [oldSecret, setOldSecret] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const resetForms = () => {
    setOldSecret("");
    setNewSecret("");
    setConfirmSecret("");
  };

  const doSetup = async () => {
    setFeedback(null);
    if (newSecret !== confirmSecret) {
      setFeedback("两次输入不一致");
      return;
    }
    await lock.setup(newSecret);
    setFeedback(lock.error === null ? "应用锁已启用" : null);
    resetForms();
  };

  const doChange = async () => {
    setFeedback(null);
    if (newSecret !== confirmSecret) {
      setFeedback("两次输入不一致");
      return;
    }
    const ok = await lock.change(oldSecret, newSecret);
    if (ok) setFeedback("PIN/口令已更新（旧解锁令牌已作废）");
    resetForms();
  };

  const doDisable = async () => {
    setFeedback(null);
    const ok = await lock.disable(oldSecret);
    if (ok) setFeedback("应用锁已关闭");
    resetForms();
  };

  return (
    <section className="card settings-section" aria-label="应用锁">
      <div className="notif-panel-head">
        <span className="notif-panel-title">应用锁</span>
        <span className="hint-text">{lock.configured ? "已启用" : "未启用"}</span>
      </div>
      <p className="hint-text">
        打开面板先解锁（PIN 只存 SHA-256 哈希）。应用锁只管 UI 解锁，与 API 鉴权（auth.token）相互独立。
      </p>

      {!lock.configured ? (
        <div className="settings-lock-form">
          <input
            className="settings-lock-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="设置 PIN（4-6 位）或口令（≥8 位）"
            value={newSecret}
            onChange={(e) => setNewSecret(e.target.value)}
            aria-label="设置新 PIN 或口令"
          />
          <input
            className="settings-lock-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="再输一次确认"
            value={confirmSecret}
            onChange={(e) => setConfirmSecret(e.target.value)}
            aria-label="确认新 PIN 或口令"
          />
          <Button type="button" size="sm" onClick={() => void doSetup()} disabled={lock.busy || newSecret === ""}>
            {lock.busy ? "设置中…" : "设置并启用"}
          </Button>
        </div>
      ) : (
        <>
          <div className="settings-lock-form">
            <input
              className="settings-lock-input"
              type="password"
              autoComplete="off"
              placeholder="旧 PIN / 口令"
              value={oldSecret}
              onChange={(e) => setOldSecret(e.target.value)}
              aria-label="旧 PIN 或口令"
            />
            <input
              className="settings-lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="新 PIN（4-6 位）或口令（≥8 位）"
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
              aria-label="新 PIN 或口令"
            />
            <input
              className="settings-lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="再输一次确认"
              value={confirmSecret}
              onChange={(e) => setConfirmSecret(e.target.value)}
              aria-label="确认新 PIN 或口令"
            />
            <div className="settings-lock-actions">
              <Button type="button" size="sm" onClick={() => void doChange()} disabled={lock.busy || oldSecret === "" || newSecret === ""}>
                修改 PIN / 口令
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void doDisable()} disabled={lock.busy || oldSecret === ""}>
                关闭应用锁
              </Button>
            </div>
          </div>
          <div className="settings-lock-actions">
            <Button type="button" variant="secondary" size="sm" onClick={lock.lockNow}>
              立即锁定
            </Button>
            {lock.webauthnAvailable && !lock.hasWebAuthnCredential && (
              <Button type="button" variant="secondary" size="sm" onClick={() => void lock.registerBiometric()} disabled={lock.busy}>
                启用面容 / 指纹解锁
              </Button>
            )}
            {lock.webauthnAvailable && lock.hasWebAuthnCredential && (
              <span className="hint-text">🔐 生物识别快捷解锁已启用</span>
            )}
          </div>
        </>
      )}

      {feedback && <div className="settings-lock-feedback">{feedback}</div>}
      {lock.error && (
        <div className="settings-lock-feedback lock-error" role="alert">
          {lock.error}
        </div>
      )}
    </section>
  );
}
