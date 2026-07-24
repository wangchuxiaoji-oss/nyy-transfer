import { authFetch, API_BASE } from "./auth";
import { createHttpError, isHttpStatusError } from "./errors";
import type { ShareDownloadResponse, ShareInfo } from "./api";
import type { DownloadConfig } from "./smart-download";

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

export interface AdminDashboard {
  tasks: {
    reports_pending: number;
    emails_failed: number;
    suspicious_access: number;
    doubao_unavailable: number;
  };
  today: {
    shares_created: number;
    links_issued: number;
    human_interactions: number;
    preview_fetches: number;
    uploaded_bytes: number;
  };
  totals: AdminStats;
}

export interface AdminIpGeo {
  country: string;
  region: string;
  city: string;
  isp: string;
}

export interface AdminIpSource {
  ip: string;
  geo: AdminIpGeo;
}

export interface AdminUserItem {
  id: string;
  email: string;
  plan: string;
  is_admin: boolean;
  email_verified: boolean;
  disabled: boolean;
  deleted: boolean;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
  deleted_at: string | null;
  registration_source: AdminIpSource | null;
  last_login_source: AdminIpSource | null;
}

export interface AdminUserPatch {
  plan?: "free" | "pro";
  disabled?: boolean;
  deleted?: boolean;
  email_verified?: boolean;
}

export interface AdminShareItem {
  code: string;
  title: string | null;
  owner_email: string | null;
  file_count: number;
  total_bytes: number;
  download_count: number;
  max_downloads: number;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  banned: boolean;
  banned_reason: string | null;
  source: AdminIpSource | null;
  guest_label: string;
  access_event_count: number;
  unique_access_ips: number;
  preview_fetch_count?: number;
  page_rendered_count?: number;
  human_interaction_count?: number;
  link_issued_count?: number;
  admin_review_count?: number;
  last_activity_at?: string | null;
}

export interface AdminShareView extends ShareInfo {
  status: "active" | "revoked" | "expired" | "banned" | "download_exhausted";
}

export type AdminSourceEventType =
  | "view"
  | "preview_fetch"
  | "page_rendered"
  | "human_interaction"
  | "link_issued"
  | "admin_review"
  | "register"
  | "login"
  | "active_session";

export type AdminSourceCategory = "preview" | "rendered" | "human" | "download" | "admin" | "auth" | "session" | "unknown";

export interface AdminSourceEvent {
  event_type: AdminSourceEventType;
  occurred_at: string;
  source: AdminIpSource;
  user_agent: string;
  actor_label: string;
  category?: AdminSourceCategory;
  client_kind?: "human" | "preview_bot" | "suspected_preview" | "unknown" | "admin";
  confidence?: "high" | "medium" | "low" | "高" | "中" | "低";
  detector?: string;
  request_id?: string;
}

export interface AdminShareSources {
  code: string;
  identity_type: "guest" | "user";
  identity_label: string;
  creation_source: AdminIpSource | null;
  created_at: string;
  event_count: number;
  unique_ip_count: number;
  events: AdminSourceEvent[];
  next_cursor?: string | null;
  has_more?: boolean;
  truncated?: boolean;
  truncation_reason?: string | null;
}

export interface AdminUserSources {
  user_id: string;
  email: string;
  registration_source: AdminIpSource | null;
  last_login_source: AdminIpSource | null;
  event_count: number;
  unique_ip_count: number;
  active_session_count: number;
  events: AdminSourceEvent[];
  next_cursor?: string | null;
  has_more?: boolean;
  truncated?: boolean;
  truncation_reason?: string | null;
}

export interface AdminIpRelations {
  source: AdminIpSource;
  users: Array<{ id: string; email: string; relation_types: string[] }>;
  shares: Array<{ code: string; owner_email: string | null; relation_types: string[] }>;
  guest_labels: string[];
  next_cursor?: string | null;
  has_more?: boolean;
  truncated?: boolean;
  truncation_reason?: string | null;
}

export type AdminSourceTarget =
  | { kind: "share"; id: string; label: string }
  | { kind: "user"; id: string; label: string };

export interface AdminList<T> {
  pagination_mode?: "cursor" | "page";
  items?: T[];
  total?: number | null;
  total_is_estimated?: boolean;
  page?: number | null;
  page_size?: number | null;
  next_cursor?: string | null;
  prev_cursor?: string | null;
  has_more?: boolean;
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

export type { DownloadConfig };

export interface AdminReportItem {
  id: string;
  share_code: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: string;
  share_title?: string | null;
  source?: AdminIpSource | null;
  report_count?: number;
  share_status?: string;
  note?: string | null;
}

export interface AdminEmailItem {
  id?: string;
  delivery_id?: string;
  recipient: string;
  share_code: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  last_attempt_at?: string | null;
  attempt_count?: number;
  attempt_number?: number;
  email_type?: string;
  delivery_type?: string;
}

export interface AdminAuditItem {
  id: string;
  created_at: string;
  request_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  note: string | null;
  batch_id: string | null;
  success: boolean;
  error_summary: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AdminArchivedShare {
  id: string;
  code: string;
  title: string | null;
  terminal_status: string;
  total_bytes: number;
  logical_file_count: number;
  stored_object_count: number;
  created_at: string;
  last_activity_at: string | null;
  archived_at: string;
}

export type AdminMailboxFolder = "inbox" | "starred" | "sent" | "archive" | "spam" | "trash";

export interface AdminMailboxAddress {
  name?: string | null;
  email: string;
}

export interface AdminMailboxAttachment {
  id: string;
  file_name: string;
  content_type?: string | null;
  size: number;
}

export interface AdminMailboxMessage {
  id: string;
  thread_id: string;
  folder: AdminMailboxFolder | string;
  subject: string;
  from: AdminMailboxAddress;
  to: AdminMailboxAddress[];
  cc?: AdminMailboxAddress[];
  snippet: string;
  body_text?: string | null;
  received_at: string;
  sent_at?: string | null;
  is_read: boolean;
  is_starred: boolean;
  attachment_count: number;
  attachments?: AdminMailboxAttachment[];
}

export interface AdminMailboxList {
  messages?: AdminMailboxMessage[];
  items?: AdminMailboxMessage[];
  total: number;
  page?: number;
  page_size?: number;
  folders?: Partial<Record<AdminMailboxFolder, number>>;
}

export interface AdminMailboxThread {
  message?: AdminMailboxMessage;
  messages?: AdminMailboxMessage[];
  thread?: AdminMailboxMessage[];
}

interface AdminMailboxAddressWire { name?: string | null; address?: string; email?: string }
interface AdminMailboxAttachmentWire { id: string; filename?: string; file_name?: string; content_type?: string | null; size: number }
interface AdminMailboxMessageWire {
  id: string; thread_id: string; subject: string; direction?: string;
  from_addresses?: AdminMailboxAddressWire[]; to_addresses?: AdminMailboxAddressWire[]; cc_addresses?: AdminMailboxAddressWire[];
  from?: AdminMailboxAddressWire; to?: AdminMailboxAddressWire[]; cc?: AdminMailboxAddressWire[];
  body_preview?: string; snippet?: string; text_body?: string | null; body_text?: string | null;
  date?: string | null; received_at: string; sent_at?: string | null;
  is_read: boolean; is_starred: boolean; is_archived?: boolean; is_spam?: boolean; is_trashed?: boolean;
  attachment_count: number; attachments?: AdminMailboxAttachmentWire[];
}

function normalizeMailboxAddress(value?: AdminMailboxAddressWire): AdminMailboxAddress {
  return { name: value?.name || null, email: value?.email || value?.address || "" };
}

function normalizeMailboxMessage(value: AdminMailboxMessageWire): AdminMailboxMessage {
  const from = value.from || value.from_addresses?.[0];
  const folder: AdminMailboxFolder = value.is_trashed ? "trash" : value.is_spam ? "spam" : value.is_archived ? "archive" : value.direction === "outbound" ? "sent" : "inbox";
  return {
    id: value.id,
    thread_id: value.thread_id,
    folder,
    subject: value.subject,
    from: normalizeMailboxAddress(from),
    to: (value.to || value.to_addresses || []).map(normalizeMailboxAddress),
    cc: (value.cc || value.cc_addresses || []).map(normalizeMailboxAddress),
    snippet: value.snippet || value.body_preview || "",
    body_text: value.body_text ?? value.text_body ?? null,
    received_at: value.received_at,
    sent_at: value.sent_at || value.date || null,
    is_read: value.is_read,
    is_starred: value.is_starred,
    attachment_count: value.attachment_count,
    attachments: (value.attachments || []).map((item) => ({
      id: item.id,
      file_name: item.file_name || item.filename || "附件",
      content_type: item.content_type,
      size: item.size,
    })),
  };
}

export interface AdminArchiveDryRun {
  dry_run: boolean;
  candidate_count: number;
  cutoff: string | null;
  samples: Array<{ code: string; created_at: string; last_activity_at: string | null }>;
}

export async function getAdminStats(): Promise<AdminStats> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/stats`));
}

export async function getAdminDashboard(): Promise<AdminDashboard> {
  try {
    return await handleResponse(await authFetch(`${API_BASE}/api/v1/admin/dashboard`));
  } catch (error) {
    if (!isHttpStatusError(error, 404) && !isHttpStatusError(error, 405)) throw error;
    const totals = await getAdminStats();
    return {
      tasks: {
        reports_pending: totals.reports_pending,
        emails_failed: totals.emails_failed,
        suspicious_access: 0,
        doubao_unavailable: 0,
      },
      today: {
        shares_created: 0,
        links_issued: 0,
        human_interactions: 0,
        preview_fetches: 0,
        uploaded_bytes: totals.uploaded_bytes_24h,
      },
      totals,
    };
  }
}

export async function getAdminUsers(params: { page?: number; pageSize?: number; q?: string; plan?: string; status?: string; sort?: string } = {}): Promise<AdminList<AdminUserItem>> {
  const search = new URLSearchParams();
  search.set("page", String(params.page || 1));
  search.set("page_size", String(params.pageSize || 50));
  if (params.q) search.set("q", params.q);
  if (params.plan && params.plan !== "all") search.set("plan", params.plan);
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/users?${search.toString()}`));
}

export async function updateAdminUser(id: string, patch: AdminUserPatch): Promise<AdminUserItem> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }));
}

export async function sendAdminUserPasswordReset(id: string): Promise<{ message: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/users/${id}/password-reset`, { method: "POST" }));
}

export interface AdminShareQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
  sort?: string;
  paginationMode?: "cursor" | "page";
  after?: string;
  createdFrom?: string;
  createdTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
  activityFrom?: string;
  activityTo?: string;
  minFiles?: number | null;
  maxFiles?: number | null;
  minBytes?: number | null;
  maxBytes?: number | null;
  risk?: string;
}

export async function getAdminShares(params: AdminShareQuery = {}): Promise<AdminList<AdminShareItem>> {
  const search = new URLSearchParams();
  if (params.paginationMode === "page") {
    search.set("page", String(params.page || 1));
    search.set("page_size", String(params.pageSize || 50));
  } else {
    search.set("limit", String(params.pageSize || 50));
  }
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  if (params.paginationMode) search.set("pagination_mode", params.paginationMode);
  if (params.after) search.set("after", params.after);
  if (params.paginationMode === "page") search.set("include_total", "true");
  if (params.createdFrom) search.set("created_from", params.createdFrom);
  if (params.createdTo) search.set("created_to", params.createdTo);
  if (params.expiresFrom) search.set("expires_from", params.expiresFrom);
  if (params.expiresTo) search.set("expires_to", params.expiresTo);
  if (params.activityFrom) search.set("activity_from", params.activityFrom);
  if (params.activityTo) search.set("activity_to", params.activityTo);
  if (params.minFiles !== null && params.minFiles !== undefined) search.set("min_files", String(params.minFiles));
  if (params.maxFiles !== null && params.maxFiles !== undefined) search.set("max_files", String(params.maxFiles));
  if (params.minBytes !== null && params.minBytes !== undefined) search.set("min_bytes", String(params.minBytes));
  if (params.maxBytes !== null && params.maxBytes !== undefined) search.set("max_bytes", String(params.maxBytes));
  if (params.risk && params.risk !== "all") search.set("risk", params.risk);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares?${search.toString()}`));
}

export async function getAdminShareView(code: string): Promise<AdminShareView> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares/${code}/view`));
}

export async function getAdminShareContent(code: string): Promise<ShareDownloadResponse> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares/${code}/content`, { method: "POST" }));
}

interface AdminSourceQuery {
  signal?: AbortSignal;
  after?: string;
  limit?: number;
  from?: string;
  to?: string;
}

function sourceQuery(params: AdminSourceQuery): string {
  const search = new URLSearchParams();
  if (params.after) search.set("after", params.after);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const query = search.toString();
  return query ? `?${query}` : "";
}

export async function getAdminShareSources(code: string, params: AdminSourceQuery = {}): Promise<AdminShareSources> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/shares/${code}/sources${sourceQuery(params)}`, { signal: params.signal }));
}

export async function getAdminUserSources(id: string, params: AdminSourceQuery = {}): Promise<AdminUserSources> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/users/${id}/sources${sourceQuery(params)}`, { signal: params.signal }));
}

export async function getAdminIpRelations(ip: string, params: AdminSourceQuery = {}): Promise<AdminIpRelations> {
  const query = sourceQuery(params);
  const suffix = query ? `&${query.slice(1)}` : "";
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/ip-relations?ip=${encodeURIComponent(ip)}${suffix}`, { signal: params.signal }));
}

export async function getQuotaConfig(): Promise<QuotaConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/quota`));
}

export async function getDownloadConfig(): Promise<DownloadConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/download`));
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

export async function updateAdminReportStatus(id: string, status: "pending" | "resolved" | "dismissed"): Promise<AdminReportItem> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/reports/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  }));
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

export async function retryAdminEmails(deliveryIds: string[], requestId: string): Promise<{ message?: string; accepted?: number }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/emails/batch-retry`, {
    method: "POST",
    headers: { "X-NYY-Request-ID": requestId },
    body: JSON.stringify({ delivery_ids: deliveryIds, batch_id: requestId, request_id: requestId }),
  }));
}

export async function getAdminAuditLogs(after?: string): Promise<AdminList<AdminAuditItem>> {
  const search = new URLSearchParams({ limit: "30" });
  if (after) search.set("after", after);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/audit-logs?${search.toString()}`));
}

export async function getAdminArchivedShares(after?: string): Promise<AdminList<AdminArchivedShare>> {
  const search = new URLSearchParams({ limit: "30" });
  if (after) search.set("after", after);
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/archived-shares?${search.toString()}`));
}

export async function getAdminMailboxMessages(params: { folder?: AdminMailboxFolder; q?: string; page?: number; pageSize?: number; signal?: AbortSignal } = {}): Promise<AdminMailboxList> {
  const search = new URLSearchParams({
    folder: params.folder || "inbox",
    page: String(params.page || 1),
    page_size: String(params.pageSize || 50),
  });
  if (params.q) search.set("q", params.q);
  const response = await handleResponse(await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages?${search.toString()}`, { signal: params.signal })) as { items?: AdminMailboxMessageWire[]; messages?: AdminMailboxMessageWire[]; total: number; page?: number; page_size?: number; folders?: Partial<Record<AdminMailboxFolder, number>> };
  const items = (response.items || response.messages || []).map(normalizeMailboxMessage);
  return {
    items,
    total: response.total,
    page: response.page,
    page_size: response.page_size,
    folders: response.folders,
  };
}

export async function getAdminMailboxMessage(id: string, options: { signal?: AbortSignal } = {}): Promise<AdminMailboxThread> {
  const response = await handleResponse(await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages/${encodeURIComponent(id)}`, { signal: options.signal })) as { messages?: AdminMailboxMessageWire[] };
  return { messages: (response.messages || []).map(normalizeMailboxMessage) };
}

export async function updateAdminMailboxMessage(id: string, patch: { is_read?: boolean; is_starred?: boolean; folder?: AdminMailboxFolder }): Promise<AdminMailboxMessage | { message?: string }> {
  const state: Record<string, boolean> = {};
  if (patch.is_read !== undefined) state.is_read = patch.is_read;
  if (patch.is_starred !== undefined) state.is_starred = patch.is_starred;
  if (patch.folder) {
    state.is_archived = patch.folder === "archive";
    state.is_spam = patch.folder === "spam";
    state.is_trashed = patch.folder === "trash";
  }
  const response = await handleResponse(await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages/${encodeURIComponent(id)}/state`, {
    method: "PATCH",
    body: JSON.stringify(state),
  })) as AdminMailboxMessageWire;
  return normalizeMailboxMessage(response);
}

export async function replyAdminMailboxMessage(id: string, body: { body_text: string; to?: string[]; cc?: string[] }): Promise<{ message?: string; id?: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    body: JSON.stringify({ text: body.body_text, html: "", reply_all: false }),
  }));
}

export async function forwardAdminMailboxMessage(id: string, body: { body_text: string; to: string[]; cc?: string[] }): Promise<{ message?: string; id?: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages/${encodeURIComponent(id)}/forward`, {
    method: "POST",
    body: JSON.stringify({ to: body.to, cc: body.cc || [], text: body.body_text, html: "", include_attachments: true }),
  }));
}

export async function downloadAdminMailboxAttachment(messageId: string, attachmentId: string, fileName: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/api/v1/admin/mailbox/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  if (!response.ok) throw await createHttpError(response, { fallback: "附件下载失败" });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json() as { download_url?: string };
    if (data.download_url) {
      window.open(data.download_url, "_blank", "noopener,noreferrer");
      return;
    }
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function dryRunAdminArchive(): Promise<AdminArchiveDryRun> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/archive/shares/dry-run`, { method: "POST" }));
}

export async function updateQuotaConfig(config: QuotaConfig): Promise<QuotaConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/quota`, {
    method: "PUT",
    body: JSON.stringify(config),
  }));
}

export async function updateDownloadConfig(config: DownloadConfig): Promise<DownloadConfig> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/config/download`, {
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
  sid_guard_login_at: string;
  sid_guard_expires_at: string;
  sid_guard_expires_in_hours: number | null;
  sid_guard_status: "unknown" | "ok" | "warning" | "expired";
  last_probe_at: string;
  last_probe_success_at: string;
  last_probe_error: string;
  last_heartbeat_at: string;
  last_heartbeat_success_at: string;
  last_heartbeat_error: string;
  verified: boolean;
  usable: boolean;
  check_message: string;
}

export interface DoubaoQRStartResponse {
  qr_base64: string;
  message?: string;
}

export interface DoubaoQRStatusResponse {
  status: string;
  message: string;
}

export async function getDoubaoSessionStatus(probe = false): Promise<DoubaoSessionStatus> {
  const query = probe ? "?probe=true" : "";
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/session-status${query}`));
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

export async function getDoubaoTestBSessionStatus(probe = false): Promise<DoubaoSessionStatus> {
  const query = probe ? "?probe=true" : "";
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/test-b/session-status${query}`));
}

export async function startDoubaoTestBQR(): Promise<DoubaoQRStartResponse> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/test-b/qr-start`, { method: "POST" }));
}

export async function getDoubaoTestBQRStatus(): Promise<DoubaoQRStatusResponse> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/test-b/qr-status`));
}

export async function cancelDoubaoTestBQR(): Promise<{ message: string }> {
  return handleResponse(await authFetch(`${API_BASE}/api/v1/admin/doubao/test-b/qr-cancel`, { method: "POST" }));
}
