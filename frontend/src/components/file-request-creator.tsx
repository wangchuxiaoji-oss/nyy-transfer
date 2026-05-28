"use client";

import { useId, useState } from "react";
import { ChevronDown, Copy, ExternalLink, Inbox, Lock, Plus, Settings } from "lucide-react";
import { createFileRequest } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";

interface FileRequestCreatorProps {
  loggedIn: boolean;
  onLoginClick: () => void;
  embedded?: boolean;
}

export function FileRequestCreator({ loggedIn, onLoginClick, embedded = false }: FileRequestCreatorProps) {
  const idPrefix = useId();
  const [title, setTitle] = useState("给我传文件");
  const [password, setPassword] = useState("");
  const [expiresHours, setExpiresHours] = useState(168);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxFiles, setMaxFiles] = useState(20);
  const [maxBytesValue, setMaxBytesValue] = useState("1024");
  const [maxBytesUnit, setMaxBytesUnit] = useState<"MB" | "GB">("MB");
  const [result, setResult] = useState<{ code: string; url: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const displayUrl = result ? `${window.location.origin}/r/${result.code}` : "";

  async function handleCreate() {
    if (!loggedIn) {
      onLoginClick();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const maxBytes = Math.round(Number(maxBytesValue) * (maxBytesUnit === "GB" ? 1024 * 1024 * 1024 : 1024 * 1024));
      const res = await createFileRequest({
        title,
        password,
        expires_hours: expiresHours,
        max_files: maxFiles,
        max_bytes: maxBytes,
      });
      setResult(res);
      setPassword("");
    } catch (err) {
      setError(getErrorMessage(err, "生成收件链接失败"));
    } finally {
      setLoading(false);
    }
  }

  function copyLink() {
    if (!displayUrl) return;
    navigator.clipboard.writeText(displayUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const content = (
    <>
      {!loggedIn && (
        <div className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl p-8">
          <p className="type-body-strong text-gray-800 dark:text-gray-200">收文件需要登录后使用</p>
          <p className="type-body-sm mt-2 text-gray-600 dark:text-gray-400">
            这样收到的文件才能归到你的账号里，也方便你之后管理和下载。
          </p>
          <button onClick={onLoginClick} className="btn-primary mt-4">
            登录后创建收件链接
          </button>
        </div>
      )}

      {loggedIn && (
        <div className="min-h-[180px] rounded-2xl p-6">
          <div className="space-y-4">
          <label className="block">
            <span className="type-label text-gray-700 dark:text-gray-400">链接标题</span>
            <input id={`${idPrefix}-title`} value={title} onChange={(e) => setTitle(e.target.value)} className="type-body-sm mt-1.5 min-h-[44px] w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-3 dark:text-gray-200 outline-none focus:border-nyy-600" placeholder="例如：给我传设计稿" />
          </label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="block">
              <span className="type-label text-gray-700 dark:text-gray-400">访问码（可选）</span>
              <div className="relative mt-1.5">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
                <input id={`${idPrefix}-password`} value={password} onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 4))} className="type-body-sm min-h-[44px] w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background pl-9 pr-3 dark:text-gray-200 outline-none focus:border-nyy-600" placeholder="4 位数字" inputMode="numeric" />
              </div>
            </label>
            <label className="block">
              <span className="type-label text-gray-700 dark:text-gray-400">有效期</span>
              <select id={`${idPrefix}-expires`} value={expiresHours} onChange={(e) => setExpiresHours(Number(e.target.value))} className="type-body-sm mt-1.5 min-h-[44px] rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-3 dark:text-gray-200 outline-none focus:border-nyy-600">
                <option value={24}>1 天</option>
                <option value={168}>7 天</option>
                <option value={720}>30 天</option>
              </select>
            </label>
          </div>

          {/* Advanced Settings Toggle */}
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="type-action flex items-center gap-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition">
            <Settings className="h-3.5 w-3.5" />
            <span>高级设置</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-white/5 p-3">
              <label className="block">
                <span className="type-label text-gray-600 dark:text-gray-400">最大文件数</span>
                <input type="number" min={1} max={100} value={maxFiles} onChange={(e) => setMaxFiles(Math.max(1, Math.min(100, Number(e.target.value))))}
                  className="type-body-sm mt-1 min-h-[40px] w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-3 dark:text-gray-200 outline-none focus:border-nyy-600" />
              </label>
              <label className="block">
                <span className="type-label text-gray-600 dark:text-gray-400">总容量上限</span>
                <div className="mt-1 flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600 focus-within:border-nyy-600">
                  <input type="number" min={1} value={maxBytesValue} onChange={(e) => setMaxBytesValue(e.target.value)}
                    className="type-body-sm min-h-[40px] min-w-0 flex-1 bg-white dark:bg-background px-3 dark:text-gray-200 outline-none" />
                  <select value={maxBytesUnit} onChange={(e) => setMaxBytesUnit(e.target.value as "MB" | "GB")}
                    className="type-caption border-l border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-white/5 px-2 text-gray-600 dark:text-gray-400 outline-none">
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                  </select>
                </div>
              </label>
            </div>
          )}

          {error && <p role="alert" className="type-body-sm rounded-xl bg-red-50 dark:bg-red-900/20 px-3 py-2 text-red-700 dark:text-red-400">{error}</p>}
          <button onClick={handleCreate} disabled={loading} className="btn-primary flex w-full items-center justify-center gap-2">
            <Plus className="h-4 w-4" /> {loading ? "生成中..." : "生成收件链接"}
          </button>

          {result && (
            <div className="rounded-2xl border border-green-100 dark:border-green-900/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <p className="type-label text-nyy-700 dark:text-nyy-400">收件链接已生成</p>
              <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">把这个链接发给对方，对方上传的文件会进入你的账号。</p>
              <code className="type-body mt-2 block truncate rounded-lg bg-white dark:bg-white/5 px-2 py-1.5 text-gray-700 dark:text-gray-300 select-all">{displayUrl}</code>
              <div className="mt-2 flex gap-2">
                <button onClick={copyLink} className="type-action inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-white dark:bg-white/10 px-3 text-nyy-800 dark:text-nyy-400 hover:bg-orange-100 dark:hover:bg-white/15">
                  <Copy className="h-3.5 w-3.5" /> {copied ? "已复制" : "复制链接"}
                </button>
                <a href={`/r/${result.code}`} target="_blank" rel="noopener noreferrer" className="type-action inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-white dark:bg-white/10 px-3 text-nyy-800 dark:text-nyy-400 hover:bg-orange-100 dark:hover:bg-white/15">
                  <ExternalLink className="h-3.5 w-3.5" /> 打开看看
                </a>
              </div>
            </div>
          )}
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div>{content}</div>;
  }

  return (
    <section className="relative overflow-hidden rounded-3xl border border-orange-100 dark:border-gray-700 bg-white dark:bg-card p-5 shadow-sm dark:shadow-none">
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-orange-100/70 dark:bg-orange-900/20 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="rounded-2xl bg-orange-50 dark:bg-orange-950/40 p-3 text-nyy-700 dark:text-nyy-400">
          <Inbox className="h-6 w-6" />
        </div>
        <div>
          <h2 className="type-section text-gray-900 dark:text-gray-100">收文件</h2>
          <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">生成一个收件链接，别人打开后就能把文件提交到你的账号空间。</p>
        </div>
      </div>
      <div className="relative mt-5">{content}</div>
    </section>
  );
}
