/**
 * 应用锁 API（契约 §13）：
 * - 解锁令牌只走 `X-App-Lock-Token` 请求头（绝不进 URL/日志）
 * - auth.token（API 鉴权）与应用锁完全独立：这里不涉及 auth.token
 */
import { request } from "./client";

export interface AppLockStatus {
  configured: boolean;
  webauthn: boolean;
  unlocked: boolean;
  expiresAt: number | null;
}

export interface LockTokenResult {
  ok: boolean;
  token: string;
  expiresAt: number;
}

export interface WebAuthnPublicKeyCreationJson {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  [key: string]: unknown;
}

export interface WebAuthnPublicKeyRequestJson {
  challenge: string;
  allowCredentials?: Array<{ id: string; type: string }>;
  [key: string]: unknown;
}

export interface WebAuthnRegisterStart {
  challengeId: string;
  options: { publicKey: WebAuthnPublicKeyCreationJson };
}

export interface WebAuthnLoginStart {
  challengeId: string;
  options: { publicKey: WebAuthnPublicKeyRequestJson };
}

function lockHeaders(token: string | null): Record<string, string> {
  return token ? { "X-App-Lock-Token": token } : {};
}

export const appLockApi = {
  status(token: string | null): Promise<AppLockStatus> {
    return request("/api/app-lock/status", { headers: lockHeaders(token) });
  },

  setup(secret: string): Promise<LockTokenResult> {
    return request("/api/app-lock/setup", { method: "POST", body: JSON.stringify({ secret }) });
  },

  unlock(secret: string): Promise<LockTokenResult> {
    return request("/api/app-lock/unlock", { method: "POST", body: JSON.stringify({ secret }) });
  },

  change(oldSecret: string, newSecret: string): Promise<LockTokenResult> {
    return request("/api/app-lock/change", { method: "POST", body: JSON.stringify({ oldSecret, newSecret }) });
  },

  disable(oldSecret: string): Promise<{ ok: boolean; configured: boolean }> {
    return request("/api/app-lock/disable", { method: "POST", body: JSON.stringify({ oldSecret }) });
  },

  webauthnRegisterStart(token: string): Promise<WebAuthnRegisterStart> {
    return request("/api/app-lock/webauthn/register/start", { method: "POST", headers: lockHeaders(token), body: JSON.stringify({}) });
  },

  webauthnRegisterFinish(
    token: string,
    payload: { challengeId: string; credential: { id: string; publicKey: string; clientDataJSON: string } },
  ): Promise<{ ok: boolean; webauthn: boolean }> {
    return request("/api/app-lock/webauthn/register/finish", {
      method: "POST",
      headers: lockHeaders(token),
      body: JSON.stringify(payload),
    });
  },

  webauthnLoginStart(): Promise<WebAuthnLoginStart> {
    return request("/api/app-lock/webauthn/login/start", { method: "POST", body: JSON.stringify({}) });
  },

  webauthnLoginFinish(payload: {
    challengeId: string;
    credential: { id: string; clientDataJSON: string; authenticatorData: string; signature: string };
  }): Promise<LockTokenResult> {
    return request("/api/app-lock/webauthn/login/finish", { method: "POST", body: JSON.stringify(payload) });
  },
};
