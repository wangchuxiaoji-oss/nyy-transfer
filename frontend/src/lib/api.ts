import { authFetch } from "./auth";
import { createHttpError, isHttpStatusError } from "./errors";
import type { DownloadConfig } from "./smart-download";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
const GUEST_SHARES_STORAGE_KEY = "nyy_guest_shares";

interface StoredGuestShare {
  code: string;
  url: string;
  revokeToken: string;
}

function getStoredGuestShares(): StoredGuestShare[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(localStorage.getItem(GUEST_SHARES_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    const entries: StoredGuestShare[] = [];
    for (const item of stored) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const revokeToken = typeof record.revokeToken === "string" ? record.revokeToken.trim() : "";
      if (!code || seen.has(code)) continue;
      seen.add(code);
      entries.push({ code, url, revokeToken });
    }
    return entries.slice(0, 50);
  } catch {
    return [];
  }
}

function pruneStoredGuestShares(activeCodes: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const stored = JSON.parse(localStorage.getItem(GUEST_SHARES_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return;
    const updated = stored.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const code = (item as Record<string, unknown>).code;
      return typeof code === "string" && activeCodes.has(code);
    });
    localStorage.setItem(GUEST_SHARES_STORAGE_KEY, JSON.stringify(updated.slice(0, 50)));
  } catch {}
}

async function handleResponse<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw await createHttpError(res, { fallback });
  return res.json();
}

export interface UploadInitResponse {
  upload_url: string;
  authorization: string;
  store_uri: string;
  commit_token: string;
  commit_token_expires_at: string;
}

export interface MultipartInitResponse {
  multipart_token: string;
  tos_host: string;
  store_uri: string;
  tos_auth: string;
  upload_id: string;
  part_size: number;
  part_number_base: number;
  part_count: number;
  commit_token: string;
  commit_token_expires_at: string;
}

export interface MultipartMergeResponse {
  commit_token: string;
  commit_token_expires_at: string;
}

export interface CommitFileItem {
  commit_token: string;
  store_uri: string;
  logical_file_id?: string;
  chunk_index?: number;
  chunk_total?: number;
}

export interface MediaTrackMetadata {
  id?: number;
  type: "video" | "audio" | string;
  codec: string;
  codec_tag?: string;
  duration_seconds?: number;
  timescale?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  sample_rate?: number;
  channel_count?: number;
}

export interface PlaybackAsset {
  kind: string;
  version?: number;
  size?: number;
  content_type?: string;
  sha256?: string;
  virtual_size?: number;
  sidecar_size?: number;
  source_media_start?: number;
  source_media_end?: number;
  offset_delta?: number;
  crc32?: string;
  download_url?: string;
}

export interface PlaybackHints {
  needs_virtual_faststart?: boolean;
  [key: string]: unknown;
}

export interface MediaMetadata {
  probe_version: number;
  probe_status: "ok" | "failed" | "skipped";
  probe_source?: string;
  probe_error?: string;
  container?: string;
  file_size: number;
  moov_offset?: number;
  moov_size?: number;
  is_faststart?: boolean;
  is_fragmented?: boolean;
  duration_seconds?: number;
  brands?: string[];
  video_tracks?: MediaTrackMetadata[];
  audio_tracks?: MediaTrackMetadata[];
  playback_assets?: PlaybackAsset[];
  playback_hints?: PlaybackHints;
  [key: string]: unknown;
}

export interface CommitLogicalFileItem {
  logical_file_id: string;
  file_name: string;
  file_size: number;
  content_type?: string;
  chunk_total: number;
  media_metadata?: MediaMetadata | null;
}

export interface UploadCommitResponse {
  share_code: string;
  share_url: string;
  file_count: number;
  revoke_token?: string | null;
}

export interface QuotaInfo {
  used_bytes: number;
  limit_bytes: number;
  remaining_bytes: number;
  ttl_hours: number;
}

export interface ShareFileInfo {
  file_name: string;
  file_size: number;
  file_ext: string;
  content_type: string;
  index: number;
  is_chunked: boolean;
  chunk_count: number;
  media_metadata?: MediaMetadata | null;
}

export interface ChunkDownloadInfo {
  index: number;
  size: number;
  download_url: string;
}

export interface ShareInfo {
  code: string;
  files: ShareFileInfo[];
  empty_dirs: string[];
  total_bytes: number;
  created_at: string;
  expires_at: string | null;
  download_count: number;
  max_downloads: number;
  has_password: boolean;
}

export interface ShareFileDownload {
  file_name: string;
  file_size: number;
  content_type: string;
  is_chunked: boolean;
  download_url: string;
  chunks: ChunkDownloadInfo[];
  media_metadata?: MediaMetadata | null;
}

export interface ShareDownloadResponse {
  files: ShareFileDownload[];
  empty_dirs: string[];
  expires_in: number;
}

export async function getQuota(): Promise<QuotaInfo> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/quota`);
  return handleResponse(res, "获取配额失败");
}

export async function uploadInit(params: {
  file_name: string;
  file_size: number;
  file_ext: string;
  content_type?: string;
  captcha_token?: string;
  chunk_index?: number;
  chunk_total?: number;
  logical_file_id?: string;
  logical_file_size?: number;
  request_code?: string;
  request_password?: string;
}): Promise<UploadInitResponse> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/init`, {
    method: "POST",
    body: JSON.stringify(params),
  });
  return handleResponse(res, "初始化上传失败");
}

export async function uploadCommit(params: {
  upload_batch_id?: string;
  files: CommitFileItem[];
  logical_files?: CommitLogicalFileItem[];
  empty_dirs?: string[];
  password?: string;
  expires_hours?: number;
  max_downloads?: number;
  recipients?: string[];
}): Promise<UploadCommitResponse> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/commit`, {
    method: "POST",
    body: JSON.stringify(params),
  });
  return handleResponse(res, "确认上传失败");
}

export async function multipartInit(body: {
  file_name: string; file_size: number; file_ext: string; content_type: string;
  logical_file_id: string; captcha_token?: string;
  request_code?: string; request_password?: string;
}): Promise<MultipartInitResponse> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/multipart-init`, {
    method: "POST", body: JSON.stringify(body),
  });
  return handleResponse<MultipartInitResponse>(res, "发起分片上传失败");
}

export async function multipartMerge(body: {
  multipart_token: string; crc_list: string[];
}): Promise<MultipartMergeResponse> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/multipart-merge`, {
    method: "POST", body: JSON.stringify(body),
  });
  return handleResponse<MultipartMergeResponse>(res, "分片合并失败");
}

export async function getShareInfo(code: string): Promise<ShareInfo> {
  const res = await fetch(`${API_BASE}/api/v1/shares/${code}`);
  return handleResponse(res, "分享不存在或已被删除");
}

export async function verifyShare(code: string, password: string): Promise<ShareDownloadResponse> {
  const res = await fetch(`${API_BASE}/api/v1/shares/${code}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return handleResponse(res, "提取码验证失败");
}

export async function downloadShare(code: string): Promise<ShareDownloadResponse> {
  const res = await fetch(`${API_BASE}/api/v1/shares/${code}/download`);
  return handleResponse(res, "获取下载链接失败");
}

export async function getPublicDownloadConfig(): Promise<DownloadConfig> {
  const res = await fetch(`${API_BASE}/api/v1/shares/download-config`);
  return handleResponse(res, "获取下载配置失败");
}

export async function reportShare(code: string, reason: string, detail = ""): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/shares/${code}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason, detail }),
  });
  return handleResponse(res, "举报提交失败");
}

export interface FileRequestInfo {
  code: string;
  title: string;
  has_password: boolean;
  expires_at: string | null;
  max_files: number;
  max_bytes: number;
  received_files: number;
  received_bytes: number;
}

export async function getFileRequestInfo(code: string): Promise<FileRequestInfo> {
  const res = await fetch(`${API_BASE}/api/v1/file-requests/${code}`);
  return handleResponse(res, "请求链接不存在或已被删除");
}

export async function verifyFileRequest(code: string, password: string): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/file-requests/${code}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return handleResponse(res, "访问码验证失败");
}

export async function commitFileRequest(code: string, params: { files: CommitFileItem[]; password?: string }): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/file-requests/${code}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: params.files, password: params.password || "" }),
  });
  return handleResponse(res, "提交失败");
}

export async function guestRevokeShare(code: string, revokeToken: string): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE}/api/v1/shares/${code}/guest-revoke`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revoke_token: revokeToken }),
  });
  return handleResponse(res, "撤销失败");
}

export interface GuestShareInfo {
  code: string;
  url: string;
  has_revoke_token: boolean;
  preview_files: string[];
  file_count: number;
  empty_dir_count: number;
  created_at: string | null;
  expires_at: string | null;
  total_bytes: number;
  download_count: number;
  max_downloads: number;
  has_password: boolean;
  status: "active" | "expiring" | "expired" | "download_exhausted";
}

function inferGuestShareStatus(params: { expires_at: string | null; download_count: number; max_downloads: number }): GuestShareInfo["status"] {
  if (params.max_downloads > 0 && params.download_count >= params.max_downloads) return "download_exhausted";
  if (!params.expires_at) return "active";
  const expiresAt = new Date(params.expires_at).getTime();
  if (expiresAt <= Date.now()) return "expired";
  if (expiresAt <= Date.now() + 60 * 60 * 1000) return "expiring";
  return "active";
}

function normalizeGuestShare(raw: Partial<GuestShareInfo> & { code: string; url?: string }, stored?: StoredGuestShare): GuestShareInfo {
  const downloadCount = typeof raw.download_count === "number" ? raw.download_count : 0;
  const maxDownloads = typeof raw.max_downloads === "number" ? raw.max_downloads : 0;
  const expiresAt = typeof raw.expires_at === "string" ? raw.expires_at : null;
  return {
    code: raw.code,
    url: raw.url || stored?.url || `${typeof window !== "undefined" ? window.location.origin : ""}/${raw.code}`,
    has_revoke_token: typeof raw.has_revoke_token === "boolean" ? raw.has_revoke_token : Boolean(stored?.revokeToken),
    preview_files: Array.isArray(raw.preview_files) ? raw.preview_files : [],
    file_count: typeof raw.file_count === "number" ? raw.file_count : Array.isArray(raw.preview_files) ? raw.preview_files.length : 0,
    empty_dir_count: typeof raw.empty_dir_count === "number" ? raw.empty_dir_count : 0,
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    expires_at: expiresAt,
    total_bytes: typeof raw.total_bytes === "number" ? raw.total_bytes : 0,
    download_count: downloadCount,
    max_downloads: maxDownloads,
    has_password: Boolean(raw.has_password),
    status: raw.status || inferGuestShareStatus({ expires_at: expiresAt, download_count: downloadCount, max_downloads: maxDownloads }),
  };
}

function guestShareFromPublicInfo(stored: StoredGuestShare, info: ShareInfo): GuestShareInfo {
  return normalizeGuestShare({
    code: info.code,
    url: stored.url,
    has_revoke_token: Boolean(stored.revokeToken),
    preview_files: info.files.slice(0, 3).map((file) => file.file_name),
    file_count: info.files.length,
    empty_dir_count: info.empty_dirs.length,
    created_at: info.created_at,
    expires_at: info.expires_at,
    total_bytes: info.total_bytes,
    download_count: info.download_count,
    max_downloads: info.max_downloads,
    has_password: info.has_password,
  }, stored);
}

function minimalGuestShare(stored: StoredGuestShare): GuestShareInfo {
  return normalizeGuestShare({
    code: stored.code,
    url: stored.url,
    has_revoke_token: Boolean(stored.revokeToken),
  }, stored);
}

async function getGuestSharesFallback(stored: StoredGuestShare[]): Promise<GuestShareInfo[]> {
  const results = await Promise.all(stored.map(async (item) => {
    try {
      return guestShareFromPublicInfo(item, await getShareInfo(item.code));
    } catch (error) {
      if (isHttpStatusError(error, 404) || isHttpStatusError(error, 410)) return null;
      return minimalGuestShare(item);
    }
  }));
  return results.filter((item): item is GuestShareInfo => item !== null);
}

export async function getGuestShares(): Promise<GuestShareInfo[]> {
  const stored = getStoredGuestShares();
  if (stored.length === 0) return [];

  const byCode = new Map(stored.map((item) => [item.code, item]));
  let shares: GuestShareInfo[] = [];
  const tokenBacked = stored.filter((item) => item.revokeToken);
  if (tokenBacked.length > 0) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/shares/guest-mine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shares: tokenBacked.map((item) => ({ code: item.code, revoke_token: item.revokeToken })),
        }),
      });
      const listed = await handleResponse<Array<Partial<GuestShareInfo> & { code: string; url?: string }>>(res, "查询失败");
      shares = listed.map((share) => normalizeGuestShare(share, byCode.get(share.code)));
    } catch {}
  }

  const listedCodes = new Set(shares.map((share) => share.code));
  const missing = stored.filter((item) => !listedCodes.has(item.code));
  if (missing.length > 0) {
    shares = [...shares, ...(await getGuestSharesFallback(missing))];
  }
  if (shares.length > 0) pruneStoredGuestShares(new Set(shares.map((share) => share.code)));
  return shares;
}
