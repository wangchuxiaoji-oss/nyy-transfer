"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Upload, CheckCircle2, AlertCircle, Lock, FileIcon } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { computeCRC32 } from "@/lib/crc32";
import { cancelUploadBatch, commitFileRequest, getFileRequestInfo, multipartInit, multipartMerge, uploadInit, verifyFileRequest, type CommitFileItem, type FileRequestInfo } from "@/lib/api";
import { formatXhrStatusError, getErrorMessage, isSuccessfulHttpStatus } from "@/lib/errors";
import { formatSize } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/copy";
import { ViralShareCta } from "@/components/viral-share-cta";

export default function FileRequestPage() {
  const params = useParams();
  const code = params.code as string;
  return <><FileRequestContent code={code} /><ViralShareCta compact /></>;
}

function FileRequestContent({ code }: { code: string }) {
  const passwordInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeXhrsRef = useRef<Set<XMLHttpRequest>>(new Set());
  const activeBatchRef = useRef<string | null>(null);
  const passwordRef = useRef("");
  const [info, setInfo] = useState<FileRequestInfo | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  passwordRef.current = password;
  const [verified, setVerified] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "uploading" | "done" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    getFileRequestInfo(code)
      .then((data) => { setInfo(data); setVerified(!data.has_password); setState("ready"); })
      .catch((err) => { setError(getErrorMessage(err, "请求链接不存在或已过期")); setState("error"); });
  }, [code]);

  useEffect(() => () => {
    activeXhrsRef.current.forEach((xhr) => xhr.abort());
    const uploadBatchId = activeBatchRef.current;
    if (uploadBatchId) {
      void fetch("/api/v1/uploads/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_batch_id: uploadBatchId, request_code: code, request_password: passwordRef.current }),
        keepalive: true,
      });
    }
  }, [code]);

  async function handleVerify() {
    try {
      await verifyFileRequest(code, password);
      setError("");
      setVerified(true);
    } catch (err) {
      setError(getErrorMessage(err, "访问码错误"));
    }
  }

  async function uploadSingle(file: File, uploadBatchId: string, supportsMultipart: boolean): Promise<CommitFileItem> {
    const ext = file.name.includes(".") ? file.name.split(".").pop() || "" : "";
    const logicalFileId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (supportsMultipart && file.size > 512 * 1024 * 1024) {
      const multipart = await multipartInit({
        file_name: file.name,
        file_size: file.size,
        file_ext: ext,
        content_type: file.type || "application/octet-stream",
        logical_file_id: logicalFileId,
        upload_batch_id: uploadBatchId,
        request_code: code,
        request_password: password,
      });
      const crcList: string[] = [];
      for (let index = 0; index < multipart.part_count; index += 1) {
        const blob = file.slice(index * multipart.part_size, Math.min((index + 1) * multipart.part_size, file.size));
        const crc32 = await computeCRC32(blob);
        let uploaded = false;
        let partError: Error | null = null;
        for (let attempt = 0; attempt < 3 && !uploaded; attempt += 1) {
          try {
            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              activeXhrsRef.current.add(xhr);
              const partNumber = multipart.part_number_base + index;
              xhr.open("PUT", `https://${multipart.tos_host}/${multipart.store_uri}?partNumber=${partNumber}&uploadID=${multipart.upload_id}`);
              xhr.timeout = 30 * 60 * 1000;
              xhr.setRequestHeader("Authorization", multipart.tos_auth);
              xhr.setRequestHeader("Content-CRC32", crc32);
              if (multipart.part_number_base === 1) xhr.setRequestHeader("X-Storage-Mode", "gateway");
              xhr.onload = () => {
                activeXhrsRef.current.delete(xhr);
                if (isSuccessfulHttpStatus(xhr.status)) resolve();
                else reject(new Error(formatXhrStatusError(xhr.status, "上传分片失败")));
              };
              xhr.onerror = () => { activeXhrsRef.current.delete(xhr); reject(new Error(formatXhrStatusError(0, "网络错误"))); };
              xhr.ontimeout = () => { activeXhrsRef.current.delete(xhr); reject(new Error("上传分片超时")); };
              xhr.onabort = () => { activeXhrsRef.current.delete(xhr); reject(new Error("上传已取消")); };
              xhr.send(blob);
            });
            uploaded = true;
          } catch (reason) {
            partError = reason instanceof Error ? reason : new Error("上传分片失败");
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          }
        }
        if (!uploaded) throw partError || new Error("上传分片失败");
        crcList.push(crc32);
      }
      const merged = await multipartMerge({ multipart_token: multipart.multipart_token, crc_list: crcList });
      return { commit_token: merged.commit_token, store_uri: multipart.store_uri };
    }
    const crc32 = await computeCRC32(file);
    const initRes = await uploadInit({ file_name: file.name, file_size: file.size, file_ext: ext, logical_file_id: logicalFileId, logical_file_size: file.size, upload_batch_id: uploadBatchId, request_code: code, request_password: password });
    if (initRes.upload_url) await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrsRef.current.add(xhr);
      xhr.open("POST", initRes.upload_url);
      xhr.timeout = 2 * 60 * 60 * 1000;
      xhr.setRequestHeader("Authorization", initRes.authorization);
      xhr.setRequestHeader("Content-CRC32", crc32);
      xhr.onload = () => {
        activeXhrsRef.current.delete(xhr);
        if (isSuccessfulHttpStatus(xhr.status)) resolve();
        else reject(new Error(formatXhrStatusError(xhr.status, "上传到存储服务失败")));
      };
      xhr.onerror = () => { activeXhrsRef.current.delete(xhr); reject(new Error(formatXhrStatusError(0, "网络错误"))); };
      xhr.ontimeout = () => { activeXhrsRef.current.delete(xhr); reject(new Error("上传超时")); };
      xhr.onabort = () => { activeXhrsRef.current.delete(xhr); reject(new Error("上传已取消")); };
      xhr.send(file);
    });
    return { commit_token: initRes.commit_token, store_uri: initRes.store_uri };
  }

  async function startUpload() {
    if (!info || files.length === 0) return;
    setState("uploading");
    setError("");
    const uploadBatchId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `request-${Date.now().toString(36)}`;
    activeBatchRef.current = uploadBatchId;
    try {
      const total = files.reduce((s, f) => s + f.size, 0);
      if (files.some((file) => file.size > info.max_file_bytes)) throw new Error(`单文件不能超过 ${formatSize(info.max_file_bytes)}`);
      if (files.length + info.received_files > info.max_files) throw new Error("文件数量超过请求限制");
      if (total + info.received_bytes > info.max_bytes) throw new Error("文件大小超过请求限制");
      const items = [] as CommitFileItem[];
      for (const file of files) items.push(await uploadSingle(file, uploadBatchId, info.supports_multipart));
      await commitFileRequest(code, { upload_batch_id: uploadBatchId, files: items, password });
      activeBatchRef.current = null;
      setState("done");
    } catch (err) {
      await cancelUploadBatch({ upload_batch_id: uploadBatchId, request_code: code, request_password: password }).catch(() => {});
      activeBatchRef.current = null;
      setError(getErrorMessage(err, "上传失败"));
      setState("error");
    }
  }

  if (state === "loading") return <main className="nyy-product-shell type-body flex items-center justify-center retro-text">加载中...</main>;
  if (!info) return <main className="nyy-product-shell type-body flex items-center justify-center px-4 text-center retro-text">{error}</main>;

  return (
    <main className="nyy-product-shell flex flex-col items-center justify-center px-4 py-16">
      <div className="nyy-product-content retro-panel-strong w-full max-w-md p-8">
        <div className="text-center">
          <BrandLogo href="/" className="mx-auto h-auto w-36" priority />
          <h1 className="retro-title mt-4 text-lg">{info.title}</h1>
          <p className="type-body-sm mt-1 retro-text">对方正在通过{BRAND_NAME}收文件</p>
        </div>

        {info.has_password && !verified ? (
          <div className="mt-8 space-y-3">
            <label htmlFor={passwordInputId} className="type-label flex items-center gap-1 retro-text"><Lock className="w-4 h-4" /> 需要访问码</label>
            <input id={passwordInputId} value={password} onChange={(e) => { setPassword(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} maxLength={4} inputMode="numeric" className="retro-input w-full px-4 text-center tracking-[0.5em]" />
            {error && <p role="alert" className="type-caption text-red-700">{error}</p>}
            <button onClick={handleVerify} className="btn-primary w-full">继续</button>
          </div>
        ) : state === "done" ? (
          <div className="type-body mt-8 text-center text-green-600"><CheckCircle2 className="mx-auto h-10 w-10" /><p className="mt-3">文件已提交</p></div>
        ) : (
          <div className="mt-8 space-y-4">
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            <button onClick={() => inputRef.current?.click()} className="retro-file-dropzone min-h-[140px]">
              <Upload className="h-9 w-9 text-nyy-400" />
              <span className="type-body-sm text-gray-600 dark:text-gray-400">选择要提交的文件</span>
            </button>
            <div className="space-y-2">
              {files.map((f) => <div key={f.name + f.size} className="retro-card flex items-center gap-2 p-2"><FileIcon className="h-4 w-4 retro-muted" /><span className="type-file-name flex-1 truncate retro-text">{f.name}</span><span className="type-file-meta retro-muted">{formatSize(f.size)}</span></div>)}
            </div>
            {error && <p role="alert" className="type-caption flex items-center gap-1 text-red-700 dark:text-red-400"><AlertCircle className="h-3 w-3" />{error}</p>}
            <button disabled={state === "uploading" || files.length === 0} onClick={startUpload} className="btn-primary w-full">{state === "uploading" ? "上传中..." : "提交文件"}</button>
            <p className="type-body-sm text-center retro-text">剩余 {info.max_files - info.received_files} 个文件 / {formatSize(info.max_bytes - info.received_bytes)}</p>
          </div>
        )}
      </div>

      {/* Mobile fixed action bar (upload state only) */}
      {verified && state !== "done" && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-white/20 bg-white/70 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur-2xl dark:border-white/10 dark:bg-card/70 md:hidden">
          <button onClick={() => inputRef.current?.click()} className="retro-btn-secondary flex-1">
            <Upload className="h-4 w-4" /> 选择文件{files.length > 0 && ` (${files.length})`}
          </button>
          <button disabled={state === "uploading" || files.length === 0} onClick={startUpload} className="btn-primary flex min-h-[44px] flex-1 items-center justify-center gap-2">
            {state === "uploading" ? "上传中..." : "提交"}
          </button>
        </div>
      )}
      {/* Bottom padding for mobile action bar */}
      {verified && state !== "done" && <div className="h-16 md:hidden" />}
    </main>
  );
}
