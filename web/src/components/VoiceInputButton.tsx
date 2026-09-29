import { useMemo, useRef, useState } from "react";
import {
  collectFinalTranscript,
  collectInterimTranscript,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  SPEECH_LANG,
  type SpeechRecognitionLike,
} from "../utils/speech";

export interface VoiceInputButtonProps {
  /** 识别完成（松开后）回传最终文本 */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

const END_FALLBACK_MS = 800;

/**
 * 语音输入：按住说话、松开转文字进输入框（Web Speech API，zh-CN）。
 * 不支持的浏览器整颗按钮隐藏；录音中有野兽派脉冲反馈。
 */
export function VoiceInputButton({ onTranscript, disabled }: VoiceInputButtonProps) {
  const supported = useMemo(
    () => isSpeechRecognitionSupported(typeof window === "undefined" ? null : window),
    [],
  );
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // 不支持 → 优雅隐藏
  if (!supported) return null;

  const finish = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // 已停止
      }
    }
    setRecording(false);
    setInterim("");
    const text = bufferRef.current.trim();
    bufferRef.current = "";
    if (text !== "") onTranscriptRef.current(text);
  };

  const startListening = () => {
    if (disabled || recRef.current) return;
    const Ctor = getSpeechRecognitionCtor(window);
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = SPEECH_LANG;
    rec.interimResults = true;
    rec.continuous = true;
    bufferRef.current = "";
    setInterim("");
    rec.onresult = (ev) => {
      bufferRef.current = collectFinalTranscript(ev);
      setInterim(collectInterimTranscript(ev));
    };
    rec.onerror = () => finish();
    rec.onend = () => finish();
    recRef.current = rec;
    setRecording(true);
    try {
      rec.start();
    } catch {
      finish();
    }
  };

  const stopListening = () => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      finish();
      return;
    }
    // 兜底：个别实现不回调 onend 时也要把结果提交进输入框
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => finish(), END_FALLBACK_MS);
    }
  };

  return (
    <span className="voice-wrap">
      {recording && interim !== "" && <span className="voice-interim">{interim}</span>}
      <button
        type="button"
        className={`voice-btn${recording ? " recording" : ""}`}
        aria-label={recording ? "松开结束语音输入" : "按住说话"}
        aria-pressed={recording}
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          startListening();
        }}
        onPointerUp={stopListening}
        onPointerCancel={stopListening}
        onPointerLeave={stopListening}
      >
        {recording ? "●" : "🎙"}
      </button>
    </span>
  );
}
