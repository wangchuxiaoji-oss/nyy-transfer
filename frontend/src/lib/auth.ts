/**
 * 认证 API 客户端 + localStorage token 管理
 */

import { createHttpError, HttpStatusError } from "./errors";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

// ─── Token 管理 ─────────────────────────────────────────────────

const TOKEN_KEY = "nyy_access_token";
const REFRESH_KEY = "nyy_refresh_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

// ─── 带 auth 的 fetch ───────────────────────────────────────────

export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// ─── API 类型 ───────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
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

/** 发送验证码 */
export async function sendCode(
  email: string,
  purpose: "register" | "reset_password" = "register"
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, purpose }),
  });
  return handleResponse(res);
}

/** 注册（先验证后注册流程：验证码已通过后调用） */
export async function register(
  email: string,
  password: string
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return handleResponse(res);
}

/** 验证邮箱 */
export async function verifyEmail(
  email: string,
  code: string
): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  return handleResponse(res);
}

/** 登录 */
export async function login(
  email: string,
  password: string
): Promise<TokenResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await handleResponse<TokenResponse>(res);
  setTokens(data.access_token, data.refresh_token);
  return data;
}

/** 刷新 token */
export async function refreshToken(): Promise<TokenResponse> {
  const refresh = getRefreshToken();
  if (!refresh) throw new HttpStatusError(401, "登录状态已过期，请重新登录");
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const data = await handleResponse<TokenResponse>(res);
  setTokens(data.access_token, data.refresh_token);
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
export function logout() {
  clearTokens();
}

// ─── 我的分享 API ───────────────────────────────────────────────

export interface MyShareItem {
  code: string;
  title: string | null;
  file_count: number;
  total_bytes: number;
  has_password: boolean;
  download_count: number;
  max_downloads: number;
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

export async function createFileRequest(data: {
  title: string;
  password?: string;
  expires_hours: number;
  max_files: number;
  max_bytes: number;
}): Promise<{ code: string; url: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function getMyFileRequests(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: "active" | "revoked" | "expired" | "all";
  sort?: string;
} = {}): Promise<{ requests: MyFileRequestItem[]; total?: number; page?: number; page_size?: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/list${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function getMyRequestFiles(params: { page?: number; pageSize?: number; q?: string } = {}): Promise<{ files: MyRequestFileItem[]; total?: number; page?: number; page_size?: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/files${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function getRequestFileDownload(fileId: string): Promise<{ download_url: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/file-requests/my/files/${fileId}/download`);
  return handleResponse(res);
}

export interface MySharesListResponse {
  shares: MyShareItem[];
  total: number;
  page: number;
  page_size: number;
}

/** 获取我的分享列表 */
export async function getMyShares(
  page = 1,
  pageSize = 20,
  params: { q?: string; status?: "active" | "revoked" | "expired" | "all"; sort?: string } = {}
): Promise<MySharesListResponse> {
  const search = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  const res = await authFetch(`${API_BASE}/api/v1/my/shares?${search.toString()}`);
  return handleResponse(res);
}

/** 撤销分享 */
export async function revokeShare(code: string): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/my/shares/${code}`, {
    method: "DELETE",
  });
  return handleResponse(res);
}

/** 编辑分享 */
export async function editShare(
  code: string,
  data: { password?: string | null; expires_hours?: number | null }
): Promise<{ message: string }> {
  const res = await authFetch(`${API_BASE}/api/v1/my/shares/${code}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}
