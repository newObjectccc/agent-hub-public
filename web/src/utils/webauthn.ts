/**
 * WebAuthn（生物识别快捷解锁）浏览器侧封装：
 * - 可用性：platform authenticator 存在才显示按钮（否则隐藏，全部走 PIN）
 * - 注册/登录只做浏览器 API 编排与 base64url 编码；**验证全在 server**（验签/rpId/挑战）。
 * - 浏览器不支持 getPublicKey（拿不到 SPKI 公钥）视为不可用（优雅降级）。
 */

export function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBuf(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 生物识别是否可用（平台认证器 + 能取 SPKI 公钥） */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const ctor = (window as unknown as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential;
    if (!ctor) return false;
    if (typeof ctor.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return false;
    const available = await ctor.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return false;
    // getPublicKey 不可用（旧浏览器）→ 注册拿不到公钥，视为不可用
    return typeof (window as unknown as { AuthenticatorAttestationResponse?: unknown }).AuthenticatorAttestationResponse === "function";
  } catch {
    return false;
  }
}

export interface BiometricRegisterPayload {
  /** base64url(credential.rawId) */
  id: string;
  /** base64url(SPKI DER 公钥) */
  publicKey: string;
  /** base64url(clientDataJSON) */
  clientDataJSON: string;
}

/** 注册平台认证器（server 下发 options；这里只负责调浏览器 API + 提取字段） */
export async function createBiometricCredential(options: PublicKeyCredentialCreationOptions): Promise<BiometricRegisterPayload> {
  const credential = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
  if (!credential) throw new Error("未取得凭据");
  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getPublicKey !== "function") {
    throw new Error("浏览器不支持导出公钥");
  }
  const spki = response.getPublicKey();
  if (!spki) throw new Error("浏览器不支持导出公钥");
  return {
    id: bufToB64url(credential.rawId),
    publicKey: bufToB64url(spki),
    clientDataJSON: bufToB64url(response.clientDataJSON),
  };
}

export interface BiometricAssertionPayload {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** server 下发的 options（challenge/凭据 id 为 base64url 字符串）→ 浏览器 API 需要的 ArrayBuffer 形态 */
export function normalizeCreationOptions(raw: {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  [key: string]: unknown;
}): PublicKeyCredentialCreationOptions {
  return {
    ...(raw as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBuf(raw.challenge),
    user: { ...(raw.user as unknown as PublicKeyCredentialUserEntity), id: b64urlToBuf(raw.user.id) },
  };
}

export function normalizeRequestOptions(raw: {
  challenge: string;
  allowCredentials?: Array<{ id: string; type: string }>;
  [key: string]: unknown;
}): PublicKeyCredentialRequestOptions {
  const options = { ...(raw as unknown as PublicKeyCredentialRequestOptions) };
  options.challenge = b64urlToBuf(raw.challenge);
  if (Array.isArray(raw.allowCredentials)) {
    options.allowCredentials = raw.allowCredentials.map((c) => ({
      ...(c as unknown as PublicKeyCredentialDescriptor),
      id: b64urlToBuf(c.id),
    }));
  }
  return options;
}

/** 生物识别解锁断言（server 侧验签发令牌） */
export async function getBiometricAssertion(options: PublicKeyCredentialRequestOptions): Promise<BiometricAssertionPayload> {
  const credential = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
  if (!credential) throw new Error("未取得断言");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: bufToB64url(credential.rawId),
    clientDataJSON: bufToB64url(response.clientDataJSON),
    authenticatorData: bufToB64url(response.authenticatorData),
    signature: bufToB64url(response.signature),
  };
}
