/**
 * 应用锁解锁屏（F1）：野兽派紧凑 UI，数字键盘友好（触控 ≥44px）。
 * - setup：首次设置 PIN（4-6 位数字）或口令，输两遍防手误
 * - unlock：PIN/口令解锁；WebAuthn 可用时额外给生物识别快捷按钮（否则隐藏）
 * 安全：本组件不拉任何会话数据（由 App 门控保证页面组件不挂载）。
 */
import { useMemo, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "./ui/button";
import { isValidSecret, secretRuleHint } from "../utils/appLock";

export interface LockScreenProps {
  /** setup=首次设置；unlock=已有锁需解锁 */
  mode: "setup" | "unlock";
  busy: boolean;
  error: string | null;
  webauthnAvailable: boolean;
  onUnlock: (secret: string) => void;
  onSetup: (secret: string) => void;
  onBiometric: () => void;
  /** 状态获取失败后的重试（错误条「重试」）；缺省不显示 */
  onRetry?: () => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function LockScreen({ mode, busy, error, webauthnAvailable, onUnlock, onSetup, onBiometric, onRetry }: LockScreenProps) {
  const [entry, setEntry] = useState("");
  const [confirm, setConfirm] = useState("");
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** setup 两步：enter → confirm */
  const [step, setStep] = useState<"enter" | "confirm">("enter");

  const pinMode = !usePassphrase;
  const shown = step === "confirm" ? confirm : entry;
  const setShown = step === "confirm" ? setConfirm : setEntry;
  const dots = useMemo(() => (pinMode ? Array.from({ length: Math.max(4, shown.length) }, (_, i) => i < shown.length) : []), [pinMode, shown]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setLocalError(null);
    const value = (step === "confirm" ? confirm : entry).trim();
    if (!isValidSecret(value)) {
      setLocalError(secretRuleHint());
      return;
    }
    if (mode === "unlock") {
      onUnlock(value);
      return;
    }
    if (step === "enter") {
      setStep("confirm");
      return;
    }
    if (value !== entry.trim()) {
      setLocalError("两次输入不一致，请重新设置");
      setEntry("");
      setConfirm("");
      setStep("enter");
      return;
    }
    onSetup(value);
  };

  const appendDigit = (d: string) => {
    if (busy || !pinMode) return;
    // 函数式更新：物理键盘连击/自动填充不丢位（避免闭包旧值覆盖）
    setShown((prev) => (prev.length >= 6 ? prev : prev + d));
    setLocalError(null);
  };
  const backspace = () => {
    if (busy || !pinMode) return;
    setShown((prev) => prev.slice(0, -1));
    setLocalError(null);
  };
  /** readOnly 输入的 keydown 只来自物理键盘（软键盘不会弹出）：直接喂给自绘键盘逻辑 */
  const handlePinKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (busy || !pinMode) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      appendDigit(e.key);
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      backspace();
    }
    // Enter 交给 form 隐式提交（与「解锁」按钮同路）
  };

  const message = localError ?? error;
  const title = mode === "setup" ? "🔒 设置应用锁" : "🔒 应用锁";
  const subtitle =
    mode === "setup"
      ? step === "enter"
        ? "首次使用：设置 4-6 位数字 PIN（或口令），保护会话不被旁人看到"
        : "再输一次确认"
      : "手机在别人手里也看不到会话内容";

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label={mode === "setup" ? "设置应用锁" : "应用锁解锁"}>
      <form className="lock-card" onSubmit={submit}>
        <div className="lock-title">{title}</div>
        <div className="lock-subtitle">{subtitle}</div>

        {pinMode ? (
          <>
            <div className="lock-dots" aria-label={`已输入 ${shown.length} 位`}>
              {dots.map((filled, i) => (
                <span key={i} className={`lock-dot${filled ? " filled" : ""}`} />
              ))}
            </div>
            <input
              className="lock-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={6}
              /* readOnly：自绘数字键盘是唯一输入通道——不弹系统键盘（双键盘叠加），顺带防肩窥；
                 物理键盘输入走 onKeyDown，aria 可达性保留（仍可聚焦/读屏播报） */
              readOnly
              value={shown}
              onKeyDown={handlePinKeyDown}
              aria-label={step === "confirm" ? "再次输入 PIN" : "输入 PIN"}
              aria-readonly="true"
            />
            <div className="lock-keypad" role="group" aria-label="数字键盘">
              {KEYS.map((d) => (
                <button key={d} type="button" className="lock-key" onClick={() => appendDigit(d)} disabled={busy}>
                  {d}
                </button>
              ))}
              <button type="button" className="lock-key lock-key-clear" onClick={() => { setShown(""); setLocalError(null); }} disabled={busy}>
                清空
              </button>
              <button type="button" className="lock-key" onClick={() => appendDigit("0")} disabled={busy}>
                0
              </button>
              <button type="button" className="lock-key lock-key-back" onClick={backspace} disabled={busy} aria-label="退格">
                ⌫
              </button>
            </div>
          </>
        ) : (
          <input
            className="lock-input lock-passphrase"
            type="password"
            autoComplete="off"
            value={shown}
            onChange={(e) => {
              setShown(e.target.value);
              setLocalError(null);
            }}
            aria-label={step === "confirm" ? "再次输入口令" : "输入口令"}
          />
        )}

        {message && (
          <div className="lock-error" role="alert">
            <span className="lock-error-text">{message}</span>
            {onRetry && !busy && (
              <button type="button" className="lock-retry" onClick={onRetry}>
                重试
              </button>
            )}
          </div>
        )}

        <Button type="submit" className="lock-submit" size="lg" disabled={busy}>
          {busy ? "处理中…" : mode === "setup" ? (step === "enter" ? "下一步" : "设置并解锁") : "解锁"}
        </Button>

        <button
          type="button"
          className="lock-mode-toggle"
          onClick={() => {
            setUsePassphrase(!usePassphrase);
            setEntry("");
            setConfirm("");
            setStep("enter");
            setLocalError(null);
          }}
          disabled={busy}
        >
          {usePassphrase ? "改用数字 PIN" : "改用口令（passphrase）"}
        </button>

        {webauthnAvailable && mode === "unlock" && (
          <button type="button" className="lock-bio" onClick={onBiometric} disabled={busy} aria-label="使用生物识别解锁">
            🔐 使用面容 / 指纹解锁
          </button>
        )}
      </form>
    </div>
  );
}
