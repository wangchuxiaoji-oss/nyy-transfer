"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Upload, CheckCircle2, AlertCircle, Lock, FileIcon } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { computeCRC32 } from "@/lib/crc32";
import { commitFileRequest, getFileRequestInfo, uploadInit, verifyFileRequest, type CommitFileItem, type FileRequestInfo } from "@/lib/api";
import { formatXhrStatusError, getErrorMessage, isSuccessfulHttpStatus } from "@/lib/errors";
import { formatSize } from "@/lib/utils";

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

  if (state === "loading") return <main className="type-body min-h-dvh bg-warm-50 dark:bg-background flex items-center justify-center text-gray-600 dark:text-gray-400">加载中...</main>;
  if (!info) return <main className="type-body min-h-dvh bg-warm-50 dark:bg-background flex items-center justify-center px-4 text-center text-gray-700 dark:text-gray-300">{error}</main>;

  return (
    <main className="min-h-dvh bg-warm-50 dark:bg-background flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-3xl border border-warm-200 dark:border-gray-700 bg-white dark:bg-card p-8 shadow-sm dark:shadow-none">
        <div className="text-center">
          <BrandLogo className="mx-auto h-auto w-36" priority />
          <h1 className="type-title mt-4 text-gray-900 dark:text-gray-100">{info.title}</h1>
          <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">对方正在通过拿呀呀收文件</p>
        </div>

        {info.has_password && !verified ? (
          <div className="mt-8 space-y-3">
            <label htmlFor={passwordInputId} className="type-label text-gray-700 dark:text-gray-300 flex items-center gap-1"><Lock className="w-4 h-4" /> 需要访问码</label>
            <input id={passwordInputId} value={password} onChange={(e) => { setPassword(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} maxLength={4} inputMode="numeric" className="min-h-[44px] w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-4 text-center tracking-[0.5em] dark:text-gray-200 outline-none focus:ring-2 focus:ring-nyy-300" />
            {error && <p role="alert" className="type-caption text-red-700">{error}</p>}
            <button onClick={handleVerify} className="btn-primary w-full rounded-2xl">继续</button>
          </div>
        ) : state === "done" ? (
          <div className="type-body mt-8 text-center text-green-600"><CheckCircle2 className="mx-auto h-10 w-10" /><p className="mt-3">文件已提交</p></div>
        ) : (
          <div className="mt-8 space-y-4">
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            <button onClick={() => inputRef.current?.click()} className="flex min-h-[140px] w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-warm-200 dark:border-gray-600 bg-warm-50 dark:bg-white/5 hover:border-nyy-300 dark:hover:border-nyy-700">
              <Upload className="h-9 w-9 text-nyy-400" />
              <span className="type-body-sm text-gray-600 dark:text-gray-400">选择要提交的文件</span>
            </button>
            <div className="space-y-2">
              {files.map((f) => <div key={f.name + f.size} className="flex items-center gap-2 rounded-xl border border-gray-100 dark:border-gray-700 p-2"><FileIcon className="h-4 w-4 text-gray-500 dark:text-gray-400" /><span className="type-file-name flex-1 truncate text-gray-700 dark:text-gray-300">{f.name}</span><span className="type-file-meta text-gray-600 dark:text-gray-400">{formatSize(f.size)}</span></div>)}
            </div>
            {error && <p role="alert" className="type-caption flex items-center gap-1 text-red-700 dark:text-red-400"><AlertCircle className="h-3 w-3" />{error}</p>}
            <button disabled={state === "uploading" || files.length === 0} onClick={startUpload} className="btn-primary w-full rounded-2xl">{state === "uploading" ? "上传中..." : "提交文件"}</button>
            <p className="type-body-sm text-center text-gray-600 dark:text-gray-400">剩余 {info.max_files - info.received_files} 个文件 / {formatSize(info.max_bytes - info.received_bytes)}</p>
          </div>
        )}
      </div>

      {/* Mobile fixed action bar (upload state only) */}
      {verified && state !== "done" && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-warm-200 dark:border-gray-700 bg-white/95 dark:bg-card/95 px-4 py-3 backdrop-blur-sm md:hidden">
          <button onClick={() => inputRef.current?.click()} className="type-action flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl border border-warm-200 dark:border-gray-600 text-gray-700 dark:text-gray-300">
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
