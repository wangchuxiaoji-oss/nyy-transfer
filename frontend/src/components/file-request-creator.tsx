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
    if (password && password.length !== 4) {
      setError("访问码需要 4 位数字");
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
          <p className="type-body-strong retro-title">收文件需要登录后使用</p>
          <p className="type-body-sm mt-2 retro-text">
            这样收到的文件才能归到你的账号里，也方便你之后管理和下载。
          </p>
          <button onClick={onLoginClick} className="btn-primary mt-4">
            登录后创建收件链接
          </button>
        </div>
      )}

      {loggedIn && (
        <div className="min-h-[180px] rounded-2xl p-4 sm:p-5">
          <div className="grid gap-4">
            <div className="retro-card flex items-start gap-3 p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-nyy-500/10 text-nyy-500 shadow-[0_0_18px_rgba(255,138,61,0.16)]">
                <Inbox className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="retro-kicker">收件链接</p>
                <h3 className="retro-title mt-1 text-base">让对方直接提交文件</h3>
                <p className="type-body-sm mt-1 retro-text">设置标题、访问码和有效期，生成后把链接发给对方。</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <label className="block">
                <span className="type-label retro-text">链接标题</span>
                <input id={`${idPrefix}-title`} value={title} onChange={(e) => setTitle(e.target.value)} className="retro-input type-body-sm mt-1.5 w-full px-3" placeholder="例如：给我传设计稿" />
              </label>
              <label className="block">
                <span className="type-label retro-text">有效期</span>
                <select id={`${idPrefix}-expires`} value={expiresHours} onChange={(e) => setExpiresHours(Number(e.target.value))} className="retro-input type-body-sm mt-1.5 w-full px-3">
                  <option value={24}>1 天</option>
                  <option value={168}>7 天</option>
                  <option value={720}>30 天</option>
                </select>
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="block">
                <span className="type-label retro-text">访问码（可选）</span>
                <div className="relative mt-1.5">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
                  <input id={`${idPrefix}-password`} value={password} onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 4))} className="retro-input type-body-sm w-full pl-9 pr-3" placeholder="4 位数字，不填则公开提交" inputMode="numeric" />
                </div>
              </label>
              <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="retro-nav-button h-[44px] justify-start px-0 sm:justify-center sm:px-3">
                <Settings className="h-3.5 w-3.5" />
                <span>高级设置</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              </button>
            </div>

            {showAdvanced && (
              <div className="retro-card grid gap-3 p-3 sm:grid-cols-2">
                <label className="block">
                  <span className="type-label retro-text">最大文件数</span>
                  <input type="number" min={1} max={100} value={maxFiles} onChange={(e) => setMaxFiles(Math.max(1, Math.min(100, Number(e.target.value))))}
                    className="retro-input type-body-sm mt-1 min-h-[40px] w-full rounded-lg px-3" />
                </label>
                <label className="block">
                  <span className="type-label retro-text">总容量上限</span>
                  <div className="retro-input mt-1 flex min-h-[40px] overflow-hidden rounded-lg p-0 focus-within:border-nyy-600">
                    <input type="number" min={1} value={maxBytesValue} onChange={(e) => setMaxBytesValue(e.target.value)}
                      className="type-body-sm min-h-[40px] min-w-0 flex-1 bg-transparent px-3 outline-none" />
                    <select value={maxBytesUnit} onChange={(e) => setMaxBytesUnit(e.target.value as "MB" | "GB")}
                      className="type-caption border-l border-white/10 bg-transparent px-2 retro-text outline-none">
                      <option value="MB">MB</option>
                      <option value="GB">GB</option>
                    </select>
                  </div>
                </label>
              </div>
            )}

            {error && <p role="alert" className="type-body-sm rounded-xl bg-red-50 px-3 py-2 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</p>}

            <button onClick={handleCreate} disabled={loading} className="btn-primary flex w-full items-center justify-center gap-2 py-3">
              <Plus className="h-4 w-4" /> {loading ? "生成中..." : "生成收件链接"}
            </button>

            {result && (
              <div className="retro-card border-green-400/40 p-4">
                <p className="type-label text-nyy-700 dark:text-nyy-400">收件链接已生成</p>
                <p className="type-body-sm mt-1 retro-text">把这个链接发给对方，对方上传的文件会进入你的账号。</p>
                <code className="retro-input type-body mt-3 block truncate select-all px-2 py-1.5">{displayUrl}</code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={copyLink} className="retro-btn-secondary min-h-[44px] rounded-lg px-3">
                    <Copy className="h-3.5 w-3.5" /> {copied ? "已复制" : "复制链接"}
                  </button>
                  <a href={`/r/${result.code}`} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[44px] rounded-lg px-3">
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
    <section className="retro-panel relative overflow-hidden p-5">
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-orange-100/70 dark:bg-orange-900/20 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="retro-card p-3 text-nyy-500">
          <Inbox className="h-6 w-6" />
        </div>
        <div>
          <h2 className="retro-title text-lg">收文件</h2>
          <p className="type-body-sm mt-1 retro-text">生成一个收件链接，别人打开后就能把文件提交到你的账号空间。</p>
        </div>
      </div>
      <div className="relative mt-5">{content}</div>
    </section>
  );
}
