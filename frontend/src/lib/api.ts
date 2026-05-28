import { getToken } from "./auth";
import { createHttpError } from "./errors";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function handleResponse<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw await createHttpError(res, { fallback });
  return res.json();
}

export interface UploadInitResponse {
  upload_url: string;
  authorization: string;
  store_uri: string;
  commit_token: string;
}

export interface CommitFileItem {
  commit_token: string;
  store_uri: string;
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
  index: number;
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
  download_url: string;
}

export interface ShareDownloadResponse {
  files: ShareFileDownload[];
  empty_dirs: string[];
  expires_in: number;
}

export async function getQuota(): Promise<QuotaInfo> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/uploads/quota`, { headers });
  return handleResponse(res, "获取配额失败");
}

export async function uploadInit(params: {
  file_name: string;
  file_size: number;
  file_ext: string;
  captcha_token?: string;
  request_code?: string;
  request_password?: string;
}): Promise<UploadInitResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/uploads/init`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  return handleResponse(res, "初始化上传失败");
}

export async function uploadCommit(params: {
  files: CommitFileItem[];
  empty_dirs?: string[];
  password?: string;
  expires_hours?: number;
  max_downloads?: number;
  recipients?: string[];
}): Promise<UploadCommitResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/uploads/commit`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  return handleResponse(res, "确认上传失败");
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
  created_at: string | null;
  expires_at: string | null;
  total_bytes: number;
  download_count: number;
  max_downloads: number;
}

export async function getGuestShares(): Promise<GuestShareInfo[]> {
  const res = await fetch(`${API_BASE}/api/v1/shares/guest-mine`);
  return handleResponse(res, "查询失败");
}
