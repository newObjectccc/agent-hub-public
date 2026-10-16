/**
 * host 权限请求卡片（hub 驱动 claude 会话的手机批权限，契约 §12）：
 * sticky 常驻 composer 上方，单手可点（允许/拒绝热区 ≥44px）；
 * 应答中灰显防重复点击；过期按剩余时间提示（超时服务端一律 deny，绝不自动 allow）。
 */
import { useState } from "react";
import type { HostRequestDto } from "../api/types";

export interface HostRequestCardProps {
  request: HostRequestDto;
  /** 应答请求 id（应答中禁用按钮） */
  respondingId: string | null;
  onRespond: (requestId: string, outcome: "allow" | "deny") => void;
}

export function HostRequestCard({ request, respondingId, onRespond }: HostRequestCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const busy = respondingId === request.id;
  const expired = request.expiresAt !== null && Date.now() > request.expiresAt;

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
          onClick={() => onRespond(request.id, "deny")}
        >
          拒绝
        </button>
        <button
          type="button"
          className="host-request-btn allow"
          disabled={busy || expired}
          onClick={() => onRespond(request.id, "allow")}
        >
          {busy ? "提交中…" : "允许"}
        </button>
      </div>
      {expired && <div className="host-request-hint">已超时：服务端将自动拒绝（不会自动允许）</div>}
    </div>
  );
}
