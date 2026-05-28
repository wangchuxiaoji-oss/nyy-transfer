"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Copy, Trash2, Pencil, X, Check, Download, ExternalLink, Search } from "lucide-react";
import {
  isLoggedIn,
  getMyFileRequests,
  getMyRequestFiles,
  getRequestFileDownload,
  getMyShares,
  revokeShare,
  editShare,
  type MyFileRequestItem,
  type MyRequestFileItem,
  type MyShareItem,
} from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/skeleton";
import { Pagination } from "@/components/pagination";
import { formatSize } from "@/lib/utils";

type Tab = "shares" | "requests" | "received";
const PAGE_SIZE = 10;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MyPage() {
  return <Suspense fallback={<div className="type-body min-h-screen bg-warm-50 dark:bg-background flex items-center justify-center text-warm-600 dark:text-gray-400">加载中...</div>}><MyWorkbenchPage /></Suspense>;
}

function MyWorkbenchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  // URL-derived state
  const tabParam = searchParams.get("tab") as Tab | null;
  const activeTab: Tab = tabParam === "requests" || tabParam === "received" ? tabParam : "shares";
  const q = searchParams.get("q") || "";
  const status = searchParams.get("status") || "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Data state
  const [loading, setLoading] = useState(true);
  const [shares, setShares] = useState<MyShareItem[]>([]);
  const [sharesTot, setSharesTot] = useState(0);
  const [requests, setRequests] = useState<MyFileRequestItem[]>([]);
  const [requestsTot, setRequestsTot] = useState(0);
  const [received, setReceived] = useState<MyRequestFileItem[]>([]);
  const [receivedTot, setReceivedTot] = useState(0);

  // UI state
  const [searchDraft, setSearchDraft] = useState(q);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editExpires, setEditExpires] = useState("0");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  // Auth guard
  useEffect(() => {
    if (!isLoggedIn()) router.replace("/");
  }, [router]);

  // URL update helper
  const setQuery = useCallback(
    (patch: Record<string, string | number | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === "all") params.delete(k);
        else params.set(k, String(v));
      }
      router.replace(`/my?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  // Data fetching
  useEffect(() => {
    if (!isLoggedIn()) return;
    let cancelled = false;
    setLoading(true);

    const fetchData = async () => {
      try {
        if (activeTab === "shares") {
          const res = await getMyShares(page, PAGE_SIZE, {
            q: q || undefined,
            status: status !== "all" ? (status as "active" | "revoked" | "expired") : undefined,
          });
          if (!cancelled) { setShares(res.shares); setSharesTot(res.total); }
        } else if (activeTab === "requests") {
          const res = await getMyFileRequests({
            sort: "created_desc",
            page,
            pageSize: PAGE_SIZE,
          });
          if (!cancelled) { setRequests(res.requests); setRequestsTot(res.total ?? 0); }
        } else {
          const res = await getMyRequestFiles({ page, pageSize: PAGE_SIZE });
          if (!cancelled) { setReceived(res.files); setReceivedTot(res.total ?? 0); }
        }
      } catch (e) {
        if (!cancelled) showToast({ title: getErrorMessage(e), type: "error" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [activeTab, q, status, page, showToast]);

  // Actions
  const handleRevoke = async () => {
    if (!confirmTarget) return;
    try {
      await revokeShare(confirmTarget);
      showToast({ title: "分享已撤销", type: "success" });
      setShares((prev) => prev.filter((s) => s.code !== confirmTarget));
      setSharesTot((t) => t - 1);
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setConfirmOpen(false);
      setConfirmTarget(null);
    }
  };

  const handleEdit = async (code: string) => {
    try {
      await editShare(code, {
        password: editPassword || undefined,
        expires_hours: editExpires ? Number(editExpires) : undefined,
      });
      showToast({ title: "已保存", type: "success" });
      setEditingId(null);
      // Refresh
      const res = await getMyShares(page, PAGE_SIZE, { q: q || undefined, status: status !== "all" ? (status as "active" | "revoked" | "expired") : undefined });
      setShares(res.shares);
      setSharesTot(res.total);
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    }
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/${code}`);
    showToast({ title: "链接已复制", type: "success" });
  };

  const handleDownloadReceived = async (fileId: string) => {
    try {
      const { download_url } = await getRequestFileDownload(fileId);
      window.open(download_url, "_blank");
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "shares", label: "我的分享" },
    { key: "requests", label: "文件请求" },
    { key: "received", label: "收到的文件" },
  ];

  const totalForTab = activeTab === "shares" ? sharesTot : activeTab === "requests" ? requestsTot : receivedTot;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery({ q: searchDraft || null, page: null });
  };

  return (
    <main className="min-h-screen bg-warm-50 dark:bg-background px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <button onClick={() => router.push("/")} className="rounded-full p-2 text-warm-600 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 transition" aria-label="返回首页">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="type-title text-warm-900 dark:text-gray-100">我的工作台</h1>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-2xl bg-warm-100 dark:bg-white/5 p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setQuery({ tab: t.key === "shares" ? null : t.key, q: null, status: null, page: null })}
              className={`type-action flex-1 rounded-xl px-3 py-2 transition ${
                activeTab === t.key ? "bg-white dark:bg-white/10 text-warm-900 dark:text-gray-100 shadow-sm" : "text-warm-600 dark:text-gray-400 hover:text-warm-800 dark:hover:text-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Search & Filter */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <form onSubmit={handleSearch} className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-400" />
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder={activeTab === "shares" ? "搜索分享码或标题…" : activeTab === "requests" ? "搜索请求标题…" : "搜索文件名…"}
              className="type-body-sm w-full rounded-xl border border-warm-200 dark:border-gray-700 bg-white dark:bg-card py-2 pl-9 pr-3 text-warm-800 dark:text-gray-200 placeholder:text-warm-400 dark:placeholder:text-gray-500 focus:border-nyy focus:outline-none focus:ring-1 focus:ring-nyy/30"
            />
          </form>
          {activeTab === "shares" && (
            <select
              value={status}
              onChange={(e) => setQuery({ status: e.target.value, page: null })}
              className="type-body-sm rounded-xl border border-warm-200 dark:border-gray-700 bg-white dark:bg-card px-3 py-2 text-warm-700 dark:text-gray-300 focus:border-nyy focus:outline-none"
            >
              <option value="all">全部状态</option>
              <option value="active">有效</option>
              <option value="expired">已过期</option>
              <option value="revoked">已撤销</option>
            </select>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <ListSkeleton rows={4} />
        ) : totalForTab === 0 ? (
          <EmptyState
            title={activeTab === "shares" ? "还没有分享" : activeTab === "requests" ? "还没有文件请求" : "还没有收到文件"}
            description={activeTab === "shares" ? "上传文件后即可创建分享链接" : activeTab === "requests" ? "创建文件请求让他人向你发送文件" : "创建文件请求后，他人提交的文件会出现在这里"}
            action={activeTab !== "received" ? (
              <button onClick={() => router.push("/")} className="btn-primary">
                {activeTab === "shares" ? "去上传" : "创建请求"}
              </button>
            ) : undefined}
          />
        ) : (
          <div className="space-y-3">
            {activeTab === "shares" && shares.map((s) => (
              <ShareCard
                key={s.code}
                share={s}
                isEditing={editingId === s.code}
                editPassword={editPassword}
                editExpires={editExpires}
                onEditStart={() => { setEditingId(s.code); setEditPassword(""); setEditExpires("0"); }}
                onEditCancel={() => setEditingId(null)}
                onEditSave={() => handleEdit(s.code)}
                onEditPasswordChange={setEditPassword}
                onEditExpiresChange={setEditExpires}
                onCopy={() => handleCopy(s.code)}
                onRevoke={() => { setConfirmTarget(s.code); setConfirmOpen(true); }}
              />
            ))}

            {activeTab === "requests" && requests.map((r) => (
              <RequestCard key={r.code} request={r} onCopy={() => handleCopy(r.code)} />
            ))}

            {activeTab === "received" && received.map((f) => (
              <ReceivedCard key={f.id} file={f} onDownload={() => handleDownloadReceived(f.id)} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalForTab > PAGE_SIZE && (
          <div className="mt-6">
            <Pagination
              page={page}
              total={totalForTab}
              pageSize={PAGE_SIZE}
              onPageChange={(p) => setQuery({ page: p <= 1 ? null : p })}
            />
          </div>
        )}
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmOpen}
        title="撤销分享"
        description="撤销后链接将永久失效，无法恢复。确定要撤销吗？"
        confirmText="确定撤销"
        danger
        onConfirm={handleRevoke}
        onCancel={() => { setConfirmOpen(false); setConfirmTarget(null); }}
      />
    </main>
  );
}

/* ─── Share Card ─── */
interface ShareCardProps {
  share: MyShareItem;
  isEditing: boolean;
  editPassword: string;
  editExpires: string;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onEditPasswordChange: (v: string) => void;
  onEditExpiresChange: (v: string) => void;
  onCopy: () => void;
  onRevoke: () => void;
}

function ShareCard({ share, isEditing, editPassword, editExpires, onEditStart, onEditCancel, onEditSave, onEditPasswordChange, onEditExpiresChange, onCopy, onRevoke }: ShareCardProps) {
  const derivedStatus = share.revoked ? "revoked" : (share.expires_at && new Date(share.expires_at) < new Date()) ? "expired" : "active";
  const isActive = derivedStatus === "active";
  const statusLabel = derivedStatus === "active" ? "有效" : derivedStatus === "expired" ? "已过期" : "已撤销";
  const statusColor = derivedStatus === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : derivedStatus === "expired" ? "bg-warm-100 text-warm-600 dark:bg-gray-800 dark:text-gray-400" : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400";

  return (
    <div className="rounded-2xl border border-warm-100 dark:border-gray-700 bg-white dark:bg-card p-4 shadow-sm dark:shadow-none">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="type-body-sm font-mono font-semibold text-nyy dark:text-nyy-400">{share.code}</span>
            <span className={`type-caption rounded-full px-2 py-0.5 font-medium ${statusColor}`}>{statusLabel}</span>
          </div>
          {share.title && <p className="type-body mt-0.5 truncate text-warm-700 dark:text-gray-300">{share.title}</p>}
          <p className="type-body-sm mt-1 text-warm-500 dark:text-gray-500">
            {share.file_count} 个文件 · {formatSize(share.total_bytes)} · {formatDate(share.created_at)}
            {share.download_count > 0 && ` · ${share.download_count} 次下载`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onCopy} className="rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 hover:text-nyy dark:hover:text-nyy-400 transition" title="复制链接"><Copy className="h-4 w-4" /></button>
          {isActive && <button onClick={onEditStart} className="rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 hover:text-nyy dark:hover:text-nyy-400 transition" title="编辑"><Pencil className="h-4 w-4" /></button>}
          {isActive && <button onClick={onRevoke} className="rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition" title="撤销"><Trash2 className="h-4 w-4" /></button>}
        </div>
      </div>

      {/* Inline Edit Form */}
      {isEditing && (
        <div className="mt-3 space-y-2 border-t border-warm-100 dark:border-gray-700 pt-3">
          <input
            type="text"
            value={editPassword}
            onChange={(e) => onEditPasswordChange(e.target.value)}
            placeholder="新提取码（留空不修改）"
            className="type-body-sm w-full rounded-lg border border-warm-200 dark:border-gray-700 bg-white dark:bg-background px-3 py-1.5 dark:text-gray-200 focus:border-nyy focus:outline-none"
          />
          <select
            value={editExpires}
            onChange={(e) => onEditExpiresChange(e.target.value)}
            className="type-body-sm w-full rounded-lg border border-warm-200 dark:border-gray-700 bg-white dark:bg-background px-3 py-1.5 dark:text-gray-200 focus:border-nyy focus:outline-none"
          >
            <option value="0">永不过期</option>
            <option value="1">1 小时</option>
            <option value="24">1 天</option>
            <option value="168">7 天</option>
            <option value="720">30 天</option>
          </select>
          <div className="flex gap-2">
            <button onClick={onEditSave} className="btn-primary flex items-center gap-1 px-3 py-1.5">
              <Check className="h-3.5 w-3.5" /> 保存
            </button>
            <button onClick={onEditCancel} className="type-action flex items-center gap-1 rounded-lg border border-warm-200 dark:border-gray-700 px-3 py-1.5 text-warm-600 dark:text-gray-400 hover:bg-warm-50 dark:hover:bg-white/5 transition">
              <X className="h-3.5 w-3.5" /> 取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Request Card ─── */
function RequestCard({ request, onCopy }: { request: MyFileRequestItem; onCopy: () => void }) {
  const isActive = request.expires_at ? new Date(request.expires_at) > new Date() : true;
  const isRevoked = request.revoked;
  return (
    <div className="rounded-2xl border border-warm-100 dark:border-gray-700 bg-white dark:bg-card p-4 shadow-sm dark:shadow-none">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="type-body-sm font-mono font-semibold text-nyy dark:text-nyy-400">{request.code}</span>
            <span className={`type-caption rounded-full px-2 py-0.5 font-medium ${isRevoked ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" : isActive ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-warm-100 text-warm-600 dark:bg-gray-800 dark:text-gray-400"}`}>
              {isRevoked ? "已撤销" : isActive ? "收集中" : "已过期"}
            </span>
          </div>
          {request.title && <p className="type-body mt-0.5 truncate text-warm-700 dark:text-gray-300">{request.title}</p>}
          <p className="type-body-sm mt-1 text-warm-500 dark:text-gray-500">
            已收到 {request.file_count} 个文件 · {formatSize(request.total_bytes)} · {formatDate(request.created_at)}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onCopy} className="rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 hover:text-nyy dark:hover:text-nyy-400 transition" title="复制链接"><Copy className="h-4 w-4" /></button>
          <a href={`/r/${request.code}`} className="rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 hover:text-nyy dark:hover:text-nyy-400 transition" title="打开"><ExternalLink className="h-4 w-4" /></a>
        </div>
      </div>
    </div>
  );
}

/* ─── Received File Card ─── */
function ReceivedCard({ file, onDownload }: { file: MyRequestFileItem; onDownload: () => void }) {
  return (
    <div className="rounded-2xl border border-warm-100 dark:border-gray-700 bg-white dark:bg-card p-4 shadow-sm dark:shadow-none">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="type-file-name truncate font-medium text-warm-800 dark:text-gray-200">{file.file_name}</p>
          <p className="type-file-meta mt-0.5 text-warm-500 dark:text-gray-500">
            {formatSize(file.file_size)} · {formatDate(file.created_at)}
            {file.request_code && ` · 来自 ${file.request_code}`}
          </p>
        </div>
        <button onClick={onDownload} className="shrink-0 rounded-lg p-1.5 text-warm-500 dark:text-gray-400 hover:bg-warm-100 dark:hover:bg-white/10 hover:text-nyy dark:hover:text-nyy-400 transition" title="下载">
          <Download className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
