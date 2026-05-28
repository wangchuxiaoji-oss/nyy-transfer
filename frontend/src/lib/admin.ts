import { authFetch, API_BASE } from "./auth";
import { createHttpError } from "./errors";

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await createHttpError(res);
  return res.json();
}

export interface AdminStats {
  users_total: number;
  shares_total: number;
  shares_active: number;
  shares_banned: number;
  uploaded_bytes_total: number;
  uploaded_bytes_24h: number;
  reports_pending: number;
  emails_failed: number;
}

export interface AdminUserItem {
  id: string;
  email: string;
  plan: string;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface AdminShareItem {
  code: string;
  title: string | null;
  owner_email: string | null;
  file_count: number;
  total_bytes: number;
  download_count: number;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  banned: boolean;
  banned_reason: string | null;
}

export interface AdminList<T> {
  total: number;
  page: number;
  page_size: number;
  users?: T[];
  shares?: T[];
  reports?: T[];
  emails?: T[];
}

export interface QuotaConfig {
  guest_max_file_bytes: number;
  guest_max_active_shares: number;
  guest_ttl_hours: number;
  user_max_file_bytes: number;
  user_max_active_shares: number;
  user_ttl_hours: number;
}

export interface AdminReportItem {
  id: string;
  share_code: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: string;
}

export interface AdminEmailItem {
  recipient: string;
  share_code: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export async function getAdminStats(): Promise<AdminStats> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/stats`));
}

export async function getAdminUsers(params: { page?: number; pageSize?: number; q?: string; plan?: string; sort?: string } = {}): Promise<AdminList<AdminUserItem>> {
  const search = new URLSearchParams();
  search.set("page", String(params.page || 1));
  search.set("page_size", String(params.pageSize || 50));
  if (params.q) search.set("q", params.q);
  if (params.plan && params.plan !== "all") search.set("plan", params.plan);
  if (params.sort) search.set("sort", params.sort);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/users?${search.toString()}`));
}

export async function getAdminShares(params: { page?: number; pageSize?: number; q?: string; status?: string; sort?: string } = {}): Promise<AdminList<AdminShareItem>> {
  const search = new URLSearchParams();
  search.set("page", String(params.page || 1));
  search.set("page_size", String(params.pageSize || 50));
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares?${search.toString()}`));
}

export async function getQuotaConfig(): Promise<QuotaConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/quota`));
}

export async function getAdminReports(params: { page?: number; pageSize?: number; q?: string; status?: string } = {}): Promise<{ reports: AdminReportItem[]; total?: number; page?: number; page_size?: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  const query = search.toString();
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/reports${query ? `?${query}` : ""}`));
}

export async function getAdminEmails(params: { page?: number; pageSize?: number; q?: string; status?: string } = {}): Promise<{ emails: AdminEmailItem[]; total?: number; page?: number; page_size?: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  const query = search.toString();
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/emails${query ? `?${query}` : ""}`));
}

export async function updateQuotaConfig(config: QuotaConfig): Promise<QuotaConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/quota`, {
    method: "PUT",
    body: JSON.stringify(config),
  }));
}

export async function banAdminShare(code: string, reason?: string): Promise<{ message: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares/${code}/ban`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || null }),
  }));
}

export async function unbanAdminShare(code: string): Promise<{ message: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares/${code}/ban`, {
    method: "DELETE",
  }));
}

// ─── Doubao Session ─────────────────────────────────────────────

export interface DoubaoSessionStatus {
  has_session: boolean;
  sessionid_prefix: string;
  last_refresh: string;
  age_hours: number;
}

export interface DoubaoQRStartResponse {
  qr_base64: string;
  message?: string;
}

export interface DoubaoQRStatusResponse {
  status: string;
  message: string;
}

export async function getDoubaoSessionStatus(): Promise<DoubaoSessionStatus> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/session-status`));
}

export async function startDoubaoQR(): Promise<DoubaoQRStartResponse> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/qr-start`, { method: "POST" }));
}

export async function getDoubaoQRStatus(): Promise<DoubaoQRStatusResponse> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/qr-status`));
}

export async function cancelDoubaoQR(): Promise<{ message: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/qr-cancel`, { method: "POST" }));
}
