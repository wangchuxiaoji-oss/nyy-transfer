"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Upload, CheckCircle2, AlertCircle, Lock, FileIcon } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { computeCRC32 } from "@/lib/crc32";
import { commitFileRequest, getFileRequestInfo, uploadInit, verifyFileRequest, type CommitFileItem, type FileRequestInfo } from "@/lib/api";
import { formatXhrStatusError, getErrorMessage, isSuccessfulHttpStatus } from "@/lib/errors";
import { formatSize } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/copy";

export default function FileRequestPage() {
  const passwordInputId = useId();
  const params = useParams();
  const code = params.code as string;
  const inputRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<FileRequestInfo | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "uploading" | "done" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    getFileRequestInfo(code)
      .then((data) => { setInfo(data); setVerified(!data.has_password); setState("ready"); })
      .catch((err) => { setError(getErrorMessage(err, "请求链接不存在或已过期")); setState("error"); });
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

  async function uploadSingle(file: File): Promise<CommitFileItem> {
    const crc32 = await computeCRC32(file);
    const ext = file.name.includes(".") ? file.name.split(".").pop() || "" : "";
    const initRes = await uploadInit({ file_name: file.name, file_size: file.size, file_ext: ext, request_code: code, request_password: password });
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", initRes.upload_url);
      xhr.setRequestHeader("Authorization", initRes.authorization);
      xhr.setRequestHeader("Content-CRC32", crc32);
      xhr.onload = () => isSuccessfulHttpStatus(xhr.status) ? resolve() : reject(new Error(formatXhrStatusError(xhr.status, "上传到存储服务失败")));
      xhr.onerror = () => reject(new Error(formatXhrStatusError(0, "网络错误")));
      xhr.send(file);
    });
    return { commit_token: initRes.commit_token, store_uri: initRes.store_uri };
  }

  async function startUpload() {
    if (!info || files.length === 0) return;
    setState("uploading");
    setError("");
    try {
      const total = files.reduce((s, f) => s + f.size, 0);
      if (files.length + info.received_files > info.max_files) throw new Error("文件数量超过请求限制");
      if (total + info.received_bytes > info.max_bytes) throw new Error("文件大小超过请求限制");
      const items = [] as CommitFileItem[];
      for (const file of files) items.push(await uploadSingle(file));
      await commitFileRequest(code, { files: items, password });
      setState("done");
    } catch (err) {
      setError(getErrorMessage(err, "上传失败"));
      setState("error");
    }
  }

  if (state === "loading") return <main className="nyy-product-shell type-body flex items-center justify-center retro-text">加载中...</main>;
  if (!info) return <main className="nyy-product-shell type-body flex items-center justify-center px-4 text-center retro-text">{error}</main>;

  return (
    <main className="nyy-product-shell flex items-center justify-center px-4 py-16">
      <div className="nyy-product-content retro-panel-strong w-full max-w-md p-8">
        <div className="text-center">
          <BrandLogo className="mx-auto h-auto w-36" priority />
          <h1 className="retro-title mt-4 text-lg">{info.title}</h1>
          <p className="type-body-sm mt-1 retro-text">对方正在通过{BRAND_NAME}收文件</p>
        </div>

        {info.has_password && !verified ? (
          <div className="mt-8 space-y-3">
            <label htmlFor={passwordInputId} className="type-label flex items-center gap-1 retro-text"><Lock className="w-4 h-4" /> 需要访问码</label>
            <input id={passwordInputId} value={password} onChange={(e) => { setPassword(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} maxLength={4} inputMode="numeric" className="retro-input w-full px-4 text-center tracking-[0.5em]" />
            {error && <p role="alert" className="type-caption text-red-700">{error}</p>}
            <button onClick={handleVerify} className="btn-primary w-full rounded-2xl">继续</button>
          </div>
        ) : state === "done" ? (
          <div className="type-body mt-8 text-center text-green-600"><CheckCircle2 className="mx-auto h-10 w-10" /><p className="mt-3">文件已提交</p></div>
        ) : (
          <div className="mt-8 space-y-4">
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            <button onClick={() => inputRef.current?.click()} className="retro-card flex min-h-[140px] w-full flex-col items-center justify-center gap-3 border-dashed hover:border-nyy-400">
              <Upload className="h-9 w-9 text-nyy-400" />
              <span className="type-body-sm text-gray-600 dark:text-gray-400">选择要提交的文件</span>
            </button>
            <div className="space-y-2">
              {files.map((f) => <div key={f.name + f.size} className="retro-card flex items-center gap-2 p-2"><FileIcon className="h-4 w-4 retro-muted" /><span className="type-file-name flex-1 truncate retro-text">{f.name}</span><span className="type-file-meta retro-muted">{formatSize(f.size)}</span></div>)}
            </div>
            {error && <p role="alert" className="type-caption flex items-center gap-1 text-red-700 dark:text-red-400"><AlertCircle className="h-3 w-3" />{error}</p>}
            <button disabled={state === "uploading" || files.length === 0} onClick={startUpload} className="btn-primary w-full rounded-2xl">{state === "uploading" ? "上传中..." : "提交文件"}</button>
            <p className="type-body-sm text-center retro-text">剩余 {info.max_files - info.received_files} 个文件 / {formatSize(info.max_bytes - info.received_bytes)}</p>
          </div>
        )}
      </div>

      {/* Mobile fixed action bar (upload state only) */}
      {verified && state !== "done" && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-white/20 bg-white/70 px-4 py-3 backdrop-blur-2xl dark:border-white/10 dark:bg-card/70 md:hidden">
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
