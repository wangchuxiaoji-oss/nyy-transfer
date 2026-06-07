/**
 * 认证 API 客户端
 *
 * access_token: 内存中短期存储（15 分钟）
 * refresh_token: HttpOnly Cookie，浏览器自动携带
 */

import { createHttpError, HttpStatusError } from "./errors";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
const GUEST_ID_STORAGE_KEY = "nyy_guest_id";

// ─── Access Token 管理（内存） ─────────────────────────────────

let memoryAccessToken: string | null = null;

export function getToken(): string | null {
  return memoryAccessToken;
}

function setAccessToken(token: string) {
  memoryAccessToken = token;
}

function clearAccessToken() {
  memoryAccessToken = null;
}

/** 清理旧 localStorage token（迁移用） */
function cleanupLegacyTokens() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("nyy_access_token");
    localStorage.removeItem("nyy_refresh_token");
  } catch {
    // ignore
  }
}

function createGuestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function getGuestId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = localStorage.getItem(GUEST_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = createGuestId();
    localStorage.setItem(GUEST_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "";
  }
}

// 初始化时清理旧 token
if (typeof window !== "undefined") {
  cleanupLegacyTokens();
}

export function isLoggedIn(): boolean {
  return !!memoryAccessToken;
}

// ─── 带 auth 的 fetch（自动 refresh） ──────────────────────────

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) return false;
      const data = await res.json();
      setAccessToken(data.access_token);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  const guestId = getGuestId();
  if (guestId) headers["X-NYY-Guest-ID"] = guestId;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res = await fetch(url, { ...options, headers });

  // 401 时尝试 refresh 一次；页面刷新后内存 token 为空也需要恢复登录
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = getToken();
      if (newToken) headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  return res;
}

// ─── API 类型 ───────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user?: UserInfo;
}

export interface UserInfo {
  id: string;
  email: string;
  plan: string;
  email_verified: boolean;
}

export { API_BASE };

// ─── API 调用 ───────────────────────────────────────────────────

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await createHttpError(res);
  return res.json();
}

/** 获取 ALTCHA challenge */
export async function getCaptchaChallenge(
  purpose: "email_send" | "login" = "email_send"
): Promise<{ challenge_id: string; challenge: unknown; expires_in: number }> {
  const res = await fetch(
    `${API_BASE}/api/v1/captcha/challenge?purpose=${purpose}`
  );
  return handleResponse(res);
}

/** 校验 ALTCHA payload，返回 captcha_token */
export async function verifyCaptcha(
  challengeId: string,
  purpose: "email_send" | "login",
  payload: string
): Promise<{ captcha_token: string; expires_in: number }> {
  const res = await fetch(`${API_BASE}/api/v1/captcha/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge_id: challengeId,
      purpose,
      payload,
    }),
  });
  return handleResponse(res);
}

/** 发送验证码（需要 captcha_token） */
export async function sendCode(
  email: string,
  captchaToken: string,
  purpose: "register" | "reset_password" = "register"
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, purpose, captcha_token: captchaToken }),
  });
  return handleResponse(res);
}

/** 注册（需携带邮箱验证码） */
export async function register(
  email: string,
  password: string,
  code: string
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, code }),
  });
  return handleResponse(res);
}

/** 登录（支持可选 captcha_token） */
export async function login(
  email: string,
  password: string,
  captchaToken?: string
): Promise<TokenResponse> {
  const body: Record<string, string> = { email, password };
  if (captchaToken) body.captcha_token = captchaToken;

  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });

  if (res.status === 428) {
    const data = await res.json();
    const detail = data.detail || data;
    if (detail.error === "captcha_required") {
      throw new HttpStatusError(428, detail.message || "captcha_required");
    }
  }

  const data = await handleResponse<TokenResponse>(res);
  setAccessToken(data.access_token);
  return data;
}

/** 获取当前用户信息 */
export async function getMe(): Promise<UserInfo> {
  const res = await authFetch(`${API_BASE}/api/v1/auth/me`);
  return handleResponse(res);
}

/** 重置密码 */
export async function resetPassword(
  email: string,
  code: string,
  newPassword: string
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
  return handleResponse(res);
}

/** 登出 */
export async function logout() {
  try {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // 忽略登出错误
  } finally {
    clearAccessToken();
  }
}

// ─── 我的分享 API ───────────────────────────────────────────────

export interface MyShareItem {
  code: string;
  title: string | null;
  preview_files: string[];
  empty_dir_count: number;
  file_count: number;
  total_bytes: number;
  has_password: boolean;
  download_count: number;
  max_downloads: number;
  last_downloaded_at: string | null;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
}

export interface MyFileRequestItem {
  code: string;
  title: string;
  created_at: string;
  expires_at: string | null;
  file_count: number;
  total_bytes: number;
  revoked: boolean;
}

export interface MyRequestFileItem {
  id: string;
  request_code: string;
  file_name: string;
  file_size: number;
  created_at: string;
}

export interface MyInboxGroup {
  code: string;
  title: string;
  created_at: string;
  expires_at: string | null;
  file_count: number;
  total_bytes: number;
  max_files: number;
  max_bytes: number;
  has_password: boolean;
  revoked: boolean;
  files: MyRequestFileItem[];
}

export async function createFileRequest(data: {
  title: string;
  password?: string;
  expires_hours?: number;
  max_files?: number;
  max_bytes?: number;
}): Promise<{ code: string; url: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function getMyShares(page: number, pageSize: number, params: { q?: string; status?: string } = {}): Promise<{ shares: MyShareItem[]; total: number; page: number; page_size: number }> {
  const search = new URLSearchParams();
  search.set("page", String(page));
  search.set("page_size", String(pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/my/shares?${query}`);
  return handleResponse(res);
}

export async function revokeShare(code: string): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/my/shares/${code}`, {
    method: "DELETE",
  });
  return handleResponse(res);
}

/** 编辑分享 */
export async function editShare(
  code: string,
  data: { password?: string | null; expires_hours?: number | null; max_downloads?: number | null }
): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/my/shares/${code}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function getMyFileRequests(params: { page?: number; pageSize?: number; q?: string } = {}): Promise<{ requests: MyFileRequestItem[]; total: number; page: number; page_size: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/list${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function getMyRequestFiles(params: { page?: number; pageSize?: number; q?: string; status?: string } = {}): Promise<{ files: MyRequestFileItem[]; total: number; page: number; page_size: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/files${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function getMyInbox(params: { page?: number; pageSize?: number; q?: string; status?: "active" | "revoked" | "expired" | "all" } = {}): Promise<{ groups: MyInboxGroup[]; total: number; page: number; page_size: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/inbox${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function editFileRequest(
  code: string,
  data: { title?: string; password?: string | null; extend_hours?: number; max_files?: number; max_bytes?: number }
): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/${code}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function revokeFileRequest(code: string): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/${code}`, {
    method: "DELETE",
  });
  return handleResponse(res);
}

export async function getRequestFileDownload(fileId: string): Promise<{ download_url: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/files/${fileId}/download`);
  return handleResponse(res);
}
