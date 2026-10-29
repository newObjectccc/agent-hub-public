/**
 * host 请求卡片（hub 驱动 claude/codex 会话的手机批权限，契约 §12）：
 * sticky 常驻 composer 上方，单手可点（允许/拒绝热区 ≥44px）；
 * 应答中灰显防重复点击；过期按剩余时间提示（超时服务端一律 deny，绝不自动 allow）。
 *
 * kind 两种形态：
 * - "permission"：审批卡片（允许/拒绝）；
 * - "question"：问答卡片（Codex 工具提问 / MCP elicitation）——逐题选选项或填文本后提交，
 *   未答题跳过；「拒绝回答」发 `{ outcome: "deny" }`。提交失败卡片保留、内联报错、可重试，
 *   用户输入绝不静默丢弃。
 */
import { useState } from "react";
import type { HostRequestBody, HostRequestDto, HostUserQuestion } from "../api/types";

export interface HostRequestCardProps {
  request: HostRequestDto;
  /** 应答请求 id（应答中禁用按钮） */
  respondingId: string | null;
  /** 应答回调：审批传 { outcome }，问答传 { answers }；返回 Promise 时失败由卡片内联报错 */
  onRespond: (requestId: string, body: HostRequestBody) => void | Promise<unknown>;
}

/** 每题草稿：选中选项 + 自定义文本（文本优先） */
interface QuestionDraft {
  selected: string | null;
  text: string;
}

/** 每题生效答案：有自定义文本以文本为准，否则选中 label；两者皆无 = 跳过 */
function effectiveAnswer(draft: QuestionDraft | undefined): string | null {
  const text = draft?.text.trim() ?? "";
  if (text !== "") return text;
  return draft?.selected ?? null;
}

function QuestionBlock({
  question,
  draft,
  disabled,
  onToggleOption,
  onTextChange,
}: {
  question: HostUserQuestion;
  draft: QuestionDraft | undefined;
  disabled: boolean;
  onToggleOption: (label: string) => void;
  onTextChange: (text: string) => void;
}) {
  const options = question.options ?? [];
  return (
    <div className="host-request-q">
      {question.header !== null && question.header !== "" && (
        <div className="host-request-q-header">{question.header}</div>
      )}
      <div className="host-request-q-text">{question.question}</div>
      {options.length > 0 && (
        <div className="host-request-q-options" role="group" aria-label={question.header ?? question.question}>
          {options.map((opt) => {
            const selected = draft?.selected === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                className={`host-request-q-option${selected ? " selected" : ""}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onToggleOption(opt.label)}
              >
                <span className="host-request-q-option-label">{opt.label}</span>
                {opt.description !== null && opt.description !== "" && (
                  <span className="host-request-q-option-desc">{opt.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {/* options 为空的题只有输入框；有选项的题同题给文本输入，有文本时文本优先 */}
      <input
        className="host-request-q-input"
        type="text"
        value={draft?.text ?? ""}
        placeholder="或输入你的回答"
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
      />
    </div>
  );
}

export function HostRequestCard({ request, respondingId, onRespond }: HostRequestCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const busy = respondingId === request.id;
  const expired = request.expiresAt !== null && Date.now() > request.expiresAt;

  /** 统一应答出口：失败保留卡片与草稿，内联报错可重试（回调若吞掉错误则维持其原行为） */
  const respond = (body: HostRequestBody): void => {
    setSubmitError(null);
    void (async () => onRespond(request.id, body))().catch((e: unknown) => {
      setSubmitError(e instanceof Error ? e.message : "未知错误");
    });
  };

  if (request.kind === "question") {
    const questions = request.questions ?? [];
    const answered = questions.filter((q) => effectiveAnswer(drafts[q.id]) !== null);
    const canSubmit = answered.length > 0 && !busy && !expired;

    const submitAnswers = (): void => {
      const answers: Record<string, string[]> = {};
      for (const q of questions) {
        const value = effectiveAnswer(drafts[q.id]);
        if (value !== null) answers[q.id] = [value]; // UI 单值 → 契约单元素数组
      }
      respond({ answers });
    };

    return (
      <div className={`host-request${expired ? " expired" : ""}`} role="alertdialog" aria-label="需要你回答">
        <div className="host-request-head">
          <span className="host-request-icon" aria-hidden>
            💬
          </span>
          <div className="host-request-title-wrap">
            <div className="host-request-title">{request.title}</div>
            {request.detail !== null && request.detail !== "" && (
              <div className="host-request-sub">{request.detail}</div>
            )}
          </div>
        </div>
        {questions.map((q) => (
          <QuestionBlock
            key={q.id}
            question={q}
            draft={drafts[q.id]}
            disabled={busy || expired}
            onToggleOption={(label) =>
              setDrafts((prev) => {
                const cur = prev[q.id] ?? { selected: null, text: "" };
                return { ...prev, [q.id]: { ...cur, selected: cur.selected === label ? null : label } };
              })
            }
            onTextChange={(text) =>
              setDrafts((prev) => ({ ...prev, [q.id]: { selected: prev[q.id]?.selected ?? null, text } }))
            }
          />
        ))}
        <div className="host-request-actions">
          <button
            type="button"
            className="host-request-btn deny"
            disabled={busy || expired}
            onClick={() => respond({ outcome: "deny" })}
          >
            拒绝回答
          </button>
          <button type="button" className="host-request-btn allow" disabled={!canSubmit} onClick={submitAnswers}>
            {busy ? "提交中…" : "提交回答"}
          </button>
        </div>
        {answered.length === 0 && !expired && (
          <div className="host-request-hint">至少回答一题才能提交（未答的题自动跳过）</div>
        )}
        {submitError !== null && (
          <div className="host-request-error" role="alert">
            提交失败：{submitError}。你的回答已保留，可直接重试。
          </div>
        )}
        {expired && (
          <div className="host-request-hint">
            {request.kind === "question"
              ? "已超时：将告知模型你未作答（绝不代你回答）"
              : "已超时：服务端将自动拒绝（不会自动允许）"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`host-request${expired ? " expired" : ""}`} role="alertdialog" aria-label="需要你批准">
      <div className="host-request-head">
        <span className="host-request-icon" aria-hidden>
          🔐
        </span>
        <div className="host-request-title-wrap">
          <div className="host-request-title">需要你批准</div>
          <div className="host-request-sub">{request.title}</div>
        </div>
      </div>
      {request.detail !== null && request.detail !== "" && (
        <button
          type="button"
          className="host-request-detail-toggle"
          onClick={() => setShowDetail((v) => !v)}
          aria-expanded={showDetail}
        >
          {showDetail ? "收起详情" : "查看详情"}
        </button>
      )}
      {showDetail && <pre className="host-request-detail">{request.detail}</pre>}
      {request.requestType && <div className="host-request-hint">{request.requestType === "permissions" ? "仅批准本次请求中列出的权限，当前轮结束后失效。" : "仅批准当前操作。"}</div>}
      <div className="host-request-actions">
        <button
          type="button"
          className="host-request-btn deny"
          disabled={busy || expired}
          onClick={() => respond({ outcome: "deny" })}
        >
          拒绝
        </button>
        <button
          type="button"
          className="host-request-btn allow"
          disabled={busy || expired}
          onClick={() => respond({ outcome: "allow" })}
        >
          {busy ? "提交中…" : "允许"}
        </button>
      </div>
      {submitError !== null && (
        <div className="host-request-error" role="alert">
          应答失败：{submitError}。可直接重试。
        </div>
      )}
      {expired && <div className="host-request-hint">已超时：服务端将自动拒绝（不会自动允许）</div>}
    </div>
  );
}
