/**
 * TTUploader 封装（官方 tt-uploader 库）。
 *
 * SDK 使用 Console 模式：Apply/Commit 由后端完成，文件内容仍由浏览器直传 TOS。
 *
 * STS 凭证不持久化到前端本地存储（仅内存）。
 * 错误日志脱敏：不记录 SecretAccessKey 明文。
 */

import TTUploader, { type STSToken, type InitConfig, type ImageXFileOption } from "tt-uploader";
import { authFetch } from "./auth";
import { createHttpError, getErrorMessage } from "./errors";
import type { DebugLogFn } from "./debug";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface InitTTRequest {
  file_name: string;
  file_size: number;
  file_ext: string;
  content_type?: string;
  logical_file_id: string;
  upload_batch_id: string;
}

export interface InitTTResponse {
  // STS
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  current_time: string;
  expired_time: string;
  // ImageX 配置
  service_id: string;
  store_key: string;
  store_uri: string;
  apply_result: Record<string, unknown>;
  // commit
  commit_token: string;
  commit_token_expires_at: string;
}

export interface TTUploadResult {
  commitToken: string;
  storeUri: string;
  commitTokenExpiresAt: string;
}

// ---------------------------------------------------------------------------
// 错误脱敏：移除 SecretAccessKey 明文
// ---------------------------------------------------------------------------

const _SENSITIVE_FIELDS = new Set([
  "secret_access_key", "secretkey", "secret_key", "secretaccesskey",
  "authorization", "auth", "session_token", "sessiontoken",
]);

function sanitizeError(err: unknown): string {
  const msg = typeof err === "object" && err
    ? getErrorMessage((err as { extra?: { message?: string }; error?: unknown }).extra?.message || (err as { error?: unknown }).error || err, "")
    : getErrorMessage(err, "");
  if (!msg) return "上传失败";
  const lines = msg.split("\n");
  return lines.map((line) => {
    const lower = line.toLowerCase();
    if (_SENSITIVE_FIELDS.has(lower)) return "[REDACTED]";
    // 简单替换：冒号/等号后面的长 token
    return line.replace(/:(\s*)([a-zA-Z0-9+/=_-]{20,})/g, ": [REDACTED]")
               .replace(/=(\s*)([a-zA-Z0-9+/=_-]{20,})/g, "= [REDACTED]");
  }).join("\n");
}

// ---------------------------------------------------------------------------
// STS 获取
// ---------------------------------------------------------------------------

async function fetchInitTT(
  params: InitTTRequest,
  signal?: AbortSignal,
): Promise<InitTTResponse> {
  const res = await authFetch(`${API_BASE}/api/v1/uploads/init-tt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) throw await createHttpError(res, { fallback: "初始化上传失败" });
  return res.json();
}

// ---------------------------------------------------------------------------
// TTUploader 单文件上传
// ---------------------------------------------------------------------------

export interface TTUploadProgress {
  loaded: number;
  total: number;
  percent: number;
  partIndex: number;
  partTotal: number;
}

export interface TTUploadCallbacks {
  onProgress?: (p: TTUploadProgress) => void;
  onError?: (err: Error) => void;
  onComplete?: (result: TTUploadResult) => void;
  onCancel?: () => void;
}

export interface TTUploadContext {
  uploadName: string;
  uploadBatchId: string;
  logicalFileId: string;
}

interface TTConsoleConfig extends InitConfig {
  useConsoleMode: true;
  uploadSliceCount: number;
  apply: (params: Record<string, unknown>) => Promise<{ result: Record<string, unknown> }>;
  commit: (
    params: Record<string, unknown>,
    body: { SessionKey?: string; SuccessOids?: string[] },
  ) => Promise<{ result: Record<string, unknown> }>;
}

/**
 * 使用 TTUploader 将单个文件直传 TOS。
 *
 * @returns 取消函数，调用后立即取消上传
 */
export function uploadWithTTUploader(
  file: File,
  context: TTUploadContext,
  callbacks: TTUploadCallbacks,
  debugLog?: DebugLogFn,
): () => void {
  const fileSize = file.size;
  const ext = context.uploadName.includes(".") ? context.uploadName.split(".").pop() || "" : "";
  const abortController = new AbortController();

  let uploader: TTUploader | null = null;
  let uploadKey: string | undefined;
  let cancelled = false;
  let settled = false;

  async function run() {
    if (cancelled) return;

    // Step 1: 获取 STS + TOS 元数据
    const initParams: InitTTRequest = {
      file_name: context.uploadName,
      file_size: fileSize,
      file_ext: ext,
      content_type: file.type || "",
      logical_file_id: context.logicalFileId,
      upload_batch_id: context.uploadBatchId,
    };
    try {
      debugLog?.("tt-upload", "init:start", { fileName: file.name, fileSize });
      const init = await fetchInitTT(initParams, abortController.signal);
      debugLog?.("tt-upload", "init:done", {
        fileName: file.name,
        storeUri: init.store_uri,
        commitTokenExpiresAt: init.commit_token_expires_at,
      });

      // Step 2: 构建 STS token
      const stsToken: STSToken = {
        AccessKeyId: init.access_key_id,
        SecretAccessKey: init.secret_access_key,
        SessionToken: init.session_token,
        CurrentTime: init.current_time,
        ExpiredTime: init.expired_time,
      };

      // Step 3: 配置 TTUploader（ImageX 模式）
      const config: TTConsoleConfig = {
        userId: "nyy-app",
        appId: 0,
        imageConfig: { serviceId: init.service_id },
        useLocalStorage: false,
        useConsoleMode: true,
        noLog: true,
        region: "cn-north-1",
        cnOrOverseas: "cn",
        taskParallelLimit: 1,
        uploadSliceCount: 3,
        uploadTimeout: 30 * 60 * 1000,  // 30 分钟
        requestTimeout: 30 * 60 * 1000,
        apply: async (params) => {
          const storeKeys = Array.isArray(params.StoreKeys) ? params.StoreKeys : [params.StoreKeys];
          if (storeKeys.length !== 1 || storeKeys[0] !== init.store_key) {
            throw new Error("上传对象与初始化结果不一致");
          }
          return { result: init.apply_result };
        },
        commit: async (_params, body) => {
          const response = await authFetch(`${API_BASE}/api/v1/uploads/tt-commit`, {
            method: "POST",
            body: JSON.stringify({
              commit_token: init.commit_token,
              session_key: body.SessionKey || "",
              success_oids: body.SuccessOids || [],
            }),
          });
          if (!response.ok) throw await createHttpError(response, { fallback: "确认上传失败" });
          return response.json();
        },
      };

      uploader = new TTUploader(config);

      // 监听事件
      uploader.on("progress", (info) => {
        if (cancelled || settled) return;
        const percent = Number(info.percent) || 0;
        callbacks.onProgress?.({
          loaded: Math.min(fileSize, Math.round(fileSize * percent / 100)),
          total: fileSize,
          percent,
          partIndex: info.partIndex ?? 0,
          partTotal: info.partTotal ?? 1,
        });
        debugLog?.("tt-upload", "progress", {
          fileName: file.name,
          loaded: info.loaded,
          total: info.total,
          percent: info.percent,
        });
      });

      uploader.on("error", (info) => {
        if (cancelled || settled) return;
        settled = true;
        const err = new Error(sanitizeError(info.error || info));
        debugLog?.("tt-upload", "error", {
          fileName: file.name,
          error: sanitizeError(info),
        });
        callbacks.onError?.(err);
      });

      uploader.on("complete", (info) => {
        if (cancelled || settled) return;
        const uploadResult = (info.uploadResult || {}) as Record<string, unknown>;
        const storeUri = String(uploadResult.Uri || uploadResult.ImageUri || uploadResult.SourceUri || "");
        if (storeUri !== init.store_uri) {
          settled = true;
          callbacks.onError?.(new Error("上传结果与预期对象不一致"));
          return;
        }
        settled = true;
        debugLog?.("tt-upload", "complete", {
          fileName: file.name,
          storeUri,
        });
        callbacks.onComplete?.({
          commitToken: init.commit_token,
          storeUri,
          commitTokenExpiresAt: init.commit_token_expires_at,
        });
      });

      // Step 4: 添加文件并启动上传
      const imageXOption: ImageXFileOption = {
        file,
        stsToken,
        serviceId: init.service_id,
        storeKey: init.store_key,
        skipMeta: true,
        forceMeta: false,
        overwrite: false,
      };
      uploadKey = uploader.addImageXFile(imageXOption);
      uploader.start(uploadKey);

    } catch (err) {
      if (cancelled || settled) return;
      settled = true;
      const e = new Error(sanitizeError(err));
      debugLog?.("tt-upload", "init:error", {
        fileName: file.name,
        error: sanitizeError(err),
      });
      callbacks.onError?.(e);
    }
  }

  run();

  return () => {
    cancelled = true;
    abortController.abort();
    if (uploader) {
      uploader.cancel(uploadKey);
    }
    callbacks.onCancel?.();
  };
}
