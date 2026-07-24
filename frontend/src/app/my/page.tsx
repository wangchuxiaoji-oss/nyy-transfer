"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Clock, Copy, Download, ExternalLink, FileText, Gift, Inbox, Lock, MoreHorizontal, Package, Pencil, Plus, Search, Trash2, UserPlus, X } from "lucide-react";
import { Button, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import {
  editFileRequest,
  editShare,
  getMyInbox,
  getMyShares,
  getRequestFileDownload,
  getMe,
  revokeFileRequest,
  revokeShare,
  type MyInboxGroup,
  type MyRequestFileItem,
  type MyShareItem,
} from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyLinkButton } from "@/components/copy-link-button";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatSize } from "@/lib/utils";
import { getPublicDownloadConfig, type ShareFileDownload } from "@/lib/api";
import {
  defaultDownloadConfig,
  downloadFilesToDirectoryHandle,
  downloadSmart,
  pickDownloadDirectory,
  supportsDirectoryPicker,
  type DownloadConfig,
  type SmartDownloadProgress,
} from "@/lib/smart-download";
import { getAvailableRetentionCoupons, getGrowthMe, type GrowthMe } from "@/lib/growth";

type Tab = "shares" | "inbox";
type StatusFilter = "all" | "active" | "expired" | "revoked";
type SizeUnit = "MB" | "GB";

const PAGE_SIZE = 10;
const DOWNLOAD_OPTIONS = [1, 10, 50, 100, 200, 0];
const ONE_MB = 1024 * 1024;
const ONE_GB = 1024 * ONE_MB;
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "有效" },
  { value: "expired", label: "已过期" },
  { value: "revoked", label: "已撤销" },
];

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === "all" || value === "active" || value === "expired" || value === "revoked";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sizeToDraft(bytes: number): { value: string; unit: SizeUnit } {
  if (bytes >= ONE_GB && bytes % ONE_GB === 0) {
    return { value: String(bytes / ONE_GB), unit: "GB" };
  }
  return { value: String(Math.max(1, Math.ceil(bytes / ONE_MB))), unit: "MB" };
}

function sizeDraftToBytes(value: string, unit: SizeUnit): number {
  return Math.round(Number(value) * (unit === "GB" ? ONE_GB : ONE_MB));
}

function getShareStatus(share: MyShareItem): "active" | "expired" | "revoked" {
  if (share.revoked) return "revoked";
  if (share.expires_at && new Date(share.expires_at) < new Date()) return "expired";
  return "active";
}

function getInboxStatus(group: MyInboxGroup): "active" | "expired" | "revoked" {
  if (group.revoked) return "revoked";
  if (group.expires_at && new Date(group.expires_at) < new Date()) return "expired";
  return "active";
}

function StatusBadge({ status }: { status: "active" | "expired" | "revoked" }) {
  const label = status === "active" ? "有效" : status === "expired" ? "已过期" : "已撤销";
  const cls = status === "active"
    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    : status === "expired"
      ? "bg-warm-100 text-warm-600 dark:bg-gray-800 dark:text-gray-400"
      : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400";
  return <span className={`type-caption rounded-full px-2 py-0.5 font-medium ${cls}`}>{label}</span>;
}

function GrowthBenefits({ growth }: { growth: GrowthMe }) {
  const coupons = getAvailableRetentionCoupons(growth);
  const progress = growth.invitation;
  return (
    <section data-testid="growth-benefits" className="mb-4 grid gap-3 md:grid-cols-2" aria-label="增长权益">
      <div className="retro-panel overflow-hidden p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-orange-500/12 text-orange-500"><Gift className="h-5 w-5" /></span>
          <div className="min-w-0">
            <p className="retro-kicker">保留权益</p>
            <h2 className="retro-title mt-1 text-base">90 天保留券</h2>
            <p className="mt-1 type-body-sm retro-text">当前可用 {coupons.length} 张。创建分享时需要手动选择，不会自动消耗。</p>
          </div>
        </div>
        {coupons.length > 0 && <p className="mt-4 rounded-xl border border-orange-400/20 bg-orange-500/8 px-3 py-2 type-caption text-orange-700 dark:text-orange-200">最近到期：{coupons[0].expires_at ? new Date(coupons[0].expires_at).toLocaleDateString("zh-CN") : "长期有效"}</p>}
      </div>
      <div className="retro-panel p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"><UserPlus className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="retro-kicker">邀请进度</p>
            <h2 className="retro-title mt-1 text-base">已完成 {progress.invited_count} / {progress.target_count}</h2>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/8 dark:bg-white/10" aria-label={`邀请进度 ${Math.round(progress.progress_percent)}%`}>
              <span className="block h-full rounded-full bg-gradient-to-r from-orange-500 to-cyan-500" style={{ width: `${progress.progress_percent}%` }} />
            </div>
            <p className="mt-2 type-caption retro-muted">{progress.next_reward || "继续邀请可推进下一档权益"}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function downloadLabel(count: number, max: number): string {
  if (max <= 0) return `${count} 次下载 · 不限`;
  return `${count} / ${max} 次下载 · 剩余 ${Math.max(0, max - count)} 次`;
}

function downloadClass(count: number, max: number): string {
  if (max > 0 && count >= max) return "border-red-500/30 bg-red-500/10 text-red-500";
  if (max > 0 && max - count <= 5) return "border-amber-500/30 bg-amber-500/10 text-amber-500";
  return "border-nyy-500/25 bg-nyy-500/10 text-nyy-500";
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "计算中";
  return `${formatSize(bytesPerSecond)}/s`;
}

function downloadPercent(progress: SmartDownloadProgress): string {
  const percent = Math.min(100, Math.max(0, (progress.downloadedBytes / Math.max(1, progress.totalBytes)) * 100));
  if (percent > 0 && percent < 1) return `${Math.max(0.1, percent).toFixed(1)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.floor(percent)}%`;
}

export default function MyPage() {
  return <Suspense fallback={<div className="nyy-product-shell type-body flex items-center justify-center retro-text">加载中...</div>}><MyWorkbenchPage /></Suspense>;
}

function MyWorkbenchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  const tabParam = searchParams.get("tab") as Tab | null;
  const activeTab: Tab = tabParam === "inbox" ? "inbox" : "shares";
  const q = searchParams.get("q") || "";
  const rawStatus = searchParams.get("status");
  const status: StatusFilter = isStatusFilter(rawStatus) ? rawStatus : "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [shares, setShares] = useState<MyShareItem[]>([]);
  const [sharesTotal, setSharesTotal] = useState(0);
  const [inboxGroups, setInboxGroups] = useState<MyInboxGroup[]>([]);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [searchDraft, setSearchDraft] = useState(q);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editClearPassword, setEditClearPassword] = useState(false);
  const [editExpires, setEditExpires] = useState("keep");
  const [editMaxDownloads, setEditMaxDownloads] = useState("0");
  const [editingInboxCode, setEditingInboxCode] = useState<string | null>(null);
  const [requestEditTitle, setRequestEditTitle] = useState("");
  const [requestEditPassword, setRequestEditPassword] = useState("");
  const [requestEditClearPassword, setRequestEditClearPassword] = useState(false);
  const [requestEditExtendHours, setRequestEditExtendHours] = useState("keep");
  const [requestEditMaxFiles, setRequestEditMaxFiles] = useState("20");
  const [requestEditMaxBytesValue, setRequestEditMaxBytesValue] = useState("1024");
  const [requestEditMaxBytesUnit, setRequestEditMaxBytesUnit] = useState<SizeUnit>("MB");
  const [requestEditMaxBytesDirty, setRequestEditMaxBytesDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{ type: "share" | "inbox"; code: string } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [downloadingGroup, setDownloadingGroup] = useState<string | null>(null);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig>(() => defaultDownloadConfig());
  const [directoryDownloadSupported, setDirectoryDownloadSupported] = useState(false);
  const [receivedDownloadProgress, setReceivedDownloadProgress] = useState<SmartDownloadProgress | null>(null);
  const [receivedDownloadName, setReceivedDownloadName] = useState("");
  const [growth, setGrowth] = useState<GrowthMe | null>(null);
  const loadSeqRef = useRef(0);
  const downloadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(() => {
        if (!cancelled) setAuthReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      });
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    getPublicDownloadConfig()
      .then((config) => { if (!cancelled) setDownloadConfig(config); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    getGrowthMe().then((data) => { if (!cancelled) setGrowth(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [authReady]);

  useEffect(() => {
    setDirectoryDownloadSupported(supportsDirectoryPicker());
  }, []);

  useEffect(() => {
    if (!downloadConfig.leave_warning_enabled || !receivedDownloadProgress) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [downloadConfig.leave_warning_enabled, receivedDownloadProgress]);

  const setQuery = useCallback(
    (patch: Record<string, string | number | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "" || value === "all") params.delete(key);
        else params.set(key, String(value));
      }
      const query = params.toString();
      router.replace(query ? `/my?${query}` : "/my", { scroll: false });
    },
    [router, searchParams]
  );

  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  const refreshShares = useCallback(async (shouldApply: () => boolean = () => true) => {
    const res = await getMyShares(page, PAGE_SIZE, {
      q: q || undefined,
      status: status !== "all" ? status : undefined,
    });
    if (!shouldApply()) return;
    setShares(res.shares);
    setSharesTotal(res.total);
  }, [page, q, status]);

  const refreshInbox = useCallback(async (shouldApply: () => boolean = () => true) => {
    const res = await getMyInbox({
      page,
      pageSize: PAGE_SIZE,
      q: q || undefined,
      status: status !== "all" ? status : undefined,
    });
    if (!shouldApply()) return;
    setInboxGroups(res.groups);
    setInboxTotal(res.total);
    setExpandedGroups((current) => {
      const visibleCodes = new Set(res.groups.map((group) => group.code));
      const next = new Set(Array.from(current).filter((code) => visibleCodes.has(code)));
      if (next.size > 0 || res.groups.length === 0) return next;
      return new Set([res.groups[0].code]);
    });
  }, [page, q, status]);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    const shouldApply = () => !cancelled && loadSeq === loadSeqRef.current;
    setLoading(true);
    const load = async () => {
      try {
        if (activeTab === "shares") await refreshShares(shouldApply);
        else await refreshInbox(shouldApply);
      } catch (error) {
        if (shouldApply()) showToast({ title: getErrorMessage(error), type: "error" });
      } finally {
        if (shouldApply()) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [activeTab, authReady, refreshInbox, refreshShares, showToast]);

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery({ q: searchDraft || null, page: null });
  };

  const handleCopy = (path: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}${path}`);
    showToast({ title: "链接已复制", type: "success" });
  };

  const handleRevoke = async () => {
    if (!confirmTarget) return;
    try {
      if (confirmTarget.type === "share") {
        await revokeShare(confirmTarget.code);
        showToast({ title: "分享已撤销", type: "success" });
        setShares((prev) => prev.filter((share) => share.code !== confirmTarget.code));
        setSharesTotal((total) => Math.max(0, total - 1));
      } else {
        await revokeFileRequest(confirmTarget.code);
        showToast({ title: "收件链接已撤销", type: "success" });
        setEditingInboxCode(null);
        await refreshInbox();
      }
    } catch (error) {
      showToast({ title: getErrorMessage(error), type: "error" });
    } finally {
      setConfirmOpen(false);
      setConfirmTarget(null);
    }
  };

  const handleEdit = async (code: string) => {
    if (!editMaxDownloads) {
      showToast({ title: "请选择新的下载次数上限", type: "warning" });
      return;
    }
    try {
      await editShare(code, {
        password: editClearPassword ? "" : editPassword || undefined,
        expires_hours: editExpires === "keep" ? undefined : Number(editExpires),
        max_downloads: Number(editMaxDownloads),
      });
      showToast({ title: "已保存", type: "success" });
      setEditingId(null);
      await refreshShares();
    } catch (error) {
      showToast({ title: getErrorMessage(error), type: "error" });
    }
  };

  const handleEditInbox = async (group: MyInboxGroup) => {
    const title = requestEditTitle.trim();
    const maxFiles = Number(requestEditMaxFiles);
    const maxBytes = sizeDraftToBytes(requestEditMaxBytesValue, requestEditMaxBytesUnit);

    if (!title) {
      showToast({ title: "请输入收件标题", type: "warning" });
      return;
    }
    if (requestEditPassword && requestEditPassword.length !== 4) {
      showToast({ title: "访问码需要 4 位数字", type: "warning" });
      return;
    }
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
      showToast({ title: "最大文件数需要在 1 到 100 之间", type: "warning" });
      return;
    }
    if (maxFiles < group.file_count) {
      showToast({ title: "文件数上限不能低于已收到文件数", type: "warning" });
      return;
    }
    if (requestEditMaxBytesDirty) {
      const maxBytesValue = Number(requestEditMaxBytesValue);
      if (!Number.isFinite(maxBytesValue) || maxBytesValue <= 0 || maxBytes > ONE_GB) {
        showToast({ title: "收件容量上限需要在允许范围内", type: "warning" });
        return;
      }
      if (maxBytes < group.total_bytes) {
        showToast({ title: "容量上限不能低于已收到容量", type: "warning" });
        return;
      }
    }

    const payload: { title?: string; password?: string; extend_hours?: number; max_files?: number; max_bytes?: number } = {};
    if (title !== group.title) payload.title = title;
    if (requestEditClearPassword) payload.password = "";
    else if (requestEditPassword) payload.password = requestEditPassword;
    if (requestEditExtendHours !== "keep") payload.extend_hours = Number(requestEditExtendHours);
    if (maxFiles !== group.max_files) payload.max_files = maxFiles;
    if (requestEditMaxBytesDirty) payload.max_bytes = maxBytes;

    if (Object.keys(payload).length === 0) {
      showToast({ title: "没有需要保存的改动", type: "info" });
      return;
    }

    try {
      await editFileRequest(group.code, payload);
      showToast({ title: "收件链接已保存", type: "success" });
      setEditingInboxCode(null);
      await refreshInbox();
    } catch (error) {
      showToast({ title: getErrorMessage(error), type: "error" });
    }
  };

  const handleDownloadReceived = async (file: MyRequestFileItem) => {
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    setReceivedDownloadName(file.file_name);
    setReceivedDownloadProgress(null);
    try {
      const { download_url } = await getRequestFileDownload(file.id);
      const downloadFile: ShareFileDownload = {
        file_name: file.file_name,
        file_size: file.file_size,
        content_type: "",
        is_chunked: false,
        download_url,
        chunks: [],
      };
      await downloadSmart(downloadFile, {
        config: downloadConfig,
        signal: abortController.signal,
        onProgress: setReceivedDownloadProgress,
        onUnsupported: (message) => showToast({ title: message, type: "warning", duration: 6000 }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        showToast({ title: "下载已取消", type: "info" });
      } else {
        showToast({ title: getErrorMessage(error), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setReceivedDownloadProgress(null);
      setReceivedDownloadName("");
    }
  };

  const handleDownloadGroup = async (group: MyInboxGroup) => {
    if (group.files.length === 0) {
      showToast({ title: "这个收件链接还没有文件", type: "info" });
      return;
    }
    if (!downloadConfig.smart_download_enabled || !downloadConfig.filesystem_access_enabled || !directoryDownloadSupported) {
      showToast({
        title: !downloadConfig.smart_download_enabled || !downloadConfig.filesystem_access_enabled
          ? "批量保存到文件夹已关闭，请逐个下载文件。"
          : "当前浏览器不支持批量保存到文件夹，请逐个下载文件。",
        type: "warning",
        duration: 8000,
      });
      return;
    }
    let directory;
    try {
      directory = await pickDownloadDirectory();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      showToast({ title: getErrorMessage(error, "无法选择保存文件夹"), type: "error" });
      return;
    }
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    setReceivedDownloadName(group.title || "批量保存");
    setReceivedDownloadProgress(null);
    setDownloadingGroup(group.code);
    try {
      const files = await Promise.all(group.files.map(async (file) => {
        const { download_url } = await getRequestFileDownload(file.id);
        return {
          file_name: file.file_name,
          file_size: file.file_size,
          content_type: "",
          is_chunked: false,
          download_url,
          chunks: [],
        } satisfies ShareFileDownload;
      }));
      await downloadFilesToDirectoryHandle(directory, files, {
        config: downloadConfig,
        signal: abortController.signal,
        onFileStart: (file) => setReceivedDownloadName(file.file_name),
        onProgress: setReceivedDownloadProgress,
      });
      showToast({ title: "文件已保存到所选文件夹", type: "success" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        showToast({ title: "下载已取消", type: "info" });
      } else {
        showToast({ title: getErrorMessage(error, "批量保存失败"), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setDownloadingGroup(null);
      setReceivedDownloadProgress(null);
      setReceivedDownloadName("");
    }
  };

  const handleCancelReceivedDownload = () => {
    downloadAbortRef.current?.abort();
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "shares", label: "我的分享" },
    { key: "inbox", label: "收件箱" },
  ];
  const totalForTab = activeTab === "shares" ? sharesTotal : inboxTotal;
  const receivedDownloadRatio = receivedDownloadProgress
    ? Math.min(1, Math.max(0, receivedDownloadProgress.downloadedBytes / Math.max(1, receivedDownloadProgress.totalBytes)))
    : 0;
  const receivedDownloadTitle = receivedDownloadProgress?.currentFileName || receivedDownloadName || "正在保存文件";
  const receivedDownloadBatchLabel = receivedDownloadProgress?.totalFiles && receivedDownloadProgress.totalFiles > 1
    ? `第 ${receivedDownloadProgress.currentFileIndex || 1} / ${receivedDownloadProgress.totalFiles} 个`
    : "保存到本地";

  return (
    <main className="nyy-product-shell px-4 py-6 sm:px-6 lg:px-8">
      <div className="nyy-product-content mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/")} className="retro-icon-button h-11 w-11" aria-label="返回首页">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <p className="retro-kicker">nyy workbench</p>
              <h1 className="retro-title text-2xl">我的工作台</h1>
            </div>
          </div>
          {activeTab === "inbox" && (
            <button onClick={() => router.push("/?mode=receive")} className="btn-primary min-h-[44px] px-4">
              <Plus className="h-4 w-4" /> 新建收件链接
            </button>
          )}
        </div>

        {growth && <GrowthBenefits growth={growth} />}

        <div className="retro-segmented mb-4 grid grid-cols-2 gap-1" role="tablist" aria-label="工作台栏目">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setQuery({ tab: tab.key === "shares" ? null : tab.key, q: null, status: null, page: null })}
              className="retro-segment-button px-3 py-2.5"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <form onSubmit={handleSearch} className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 retro-muted" />
            <input
              type="text"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={activeTab === "shares" ? "搜索分享码或文件名..." : "搜索收件标题、请求码或文件名..."}
              aria-label={activeTab === "shares" ? "搜索分享码或文件名" : "搜索收件标题、请求码或文件名"}
              className="retro-input type-body-sm w-full py-2 pl-9 pr-3"
            />
          </form>
          <StatusMenu value={status} onChange={(nextStatus) => setQuery({ status: nextStatus, page: null })} />
        </div>

        {loading ? (
          <ListSkeleton rows={4} />
        ) : totalForTab === 0 ? (
          <EmptyState
            title={activeTab === "shares" ? "还没有分享" : "还没有收件链接"}
            description={activeTab === "shares" ? "上传文件后即可创建分享链接，工作台会自动显示内容摘要。" : "创建收件链接后，对方提交的文件会按链接分组出现在这里。"}
            action={(
              <button onClick={() => router.push(activeTab === "shares" ? "/" : "/?mode=receive")} className="btn-primary">
                {activeTab === "shares" ? "去上传" : "新建收件链接"}
              </button>
            )}
          />
        ) : activeTab === "shares" ? (
          <div className="grid gap-3">
            {shares.map((share) => (
              <ShareCard
                key={share.code}
                share={share}
                isEditing={editingId === share.code}
                editPassword={editPassword}
                editClearPassword={editClearPassword}
                editExpires={editExpires}
                editMaxDownloads={editMaxDownloads}
                onEditStart={() => {
                  setEditingInboxCode(null);
                  setEditingId(share.code);
                  setEditPassword("");
                  setEditClearPassword(false);
                  setEditExpires("keep");
                  setEditMaxDownloads(DOWNLOAD_OPTIONS.includes(share.max_downloads) ? String(share.max_downloads) : "");
                }}
                onEditCancel={() => setEditingId(null)}
                onEditSave={() => handleEdit(share.code)}
                onEditPasswordChange={setEditPassword}
                onEditClearPasswordChange={setEditClearPassword}
                onEditExpiresChange={setEditExpires}
                onEditMaxDownloadsChange={setEditMaxDownloads}
                onCopy={() => handleCopy(`/${share.code}`)}
                onRevoke={() => { setConfirmTarget({ type: "share", code: share.code }); setConfirmOpen(true); }}
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-3">
            {inboxGroups.map((group) => (
              <InboxGroupCard
                key={group.code}
                group={group}
                expanded={expandedGroups.has(group.code)}
                downloading={downloadingGroup === group.code}
                isEditing={editingInboxCode === group.code}
                editTitle={requestEditTitle}
                editPassword={requestEditPassword}
                editClearPassword={requestEditClearPassword}
                editExtendHours={requestEditExtendHours}
                editMaxFiles={requestEditMaxFiles}
                editMaxBytesValue={requestEditMaxBytesValue}
                editMaxBytesUnit={requestEditMaxBytesUnit}
                onToggle={() => setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.code)) next.delete(group.code);
                  else next.add(group.code);
                  return next;
                })}
                onCopy={() => handleCopy(`/r/${group.code}`)}
                onEditStart={() => {
                  const sizeDraft = sizeToDraft(group.max_bytes);
                  setEditingId(null);
                  setEditingInboxCode(group.code);
                  setRequestEditTitle(group.title);
                  setRequestEditPassword("");
                  setRequestEditClearPassword(false);
                  setRequestEditExtendHours("keep");
                  setRequestEditMaxFiles(String(group.max_files));
                  setRequestEditMaxBytesValue(sizeDraft.value);
                  setRequestEditMaxBytesUnit(sizeDraft.unit);
                  setRequestEditMaxBytesDirty(false);
                }}
                onEditCancel={() => setEditingInboxCode(null)}
                onEditSave={() => void handleEditInbox(group)}
                onEditTitleChange={setRequestEditTitle}
                onEditPasswordChange={setRequestEditPassword}
                onEditClearPasswordChange={setRequestEditClearPassword}
                onEditExtendHoursChange={setRequestEditExtendHours}
                onEditMaxFilesChange={setRequestEditMaxFiles}
                onEditMaxBytesValueChange={(value) => {
                  setRequestEditMaxBytesValue(value);
                  setRequestEditMaxBytesDirty(true);
                }}
                onEditMaxBytesUnitChange={(unit) => {
                  const currentBytes = sizeDraftToBytes(requestEditMaxBytesValue, requestEditMaxBytesUnit);
                  setRequestEditMaxBytesUnit(unit);
                  setRequestEditMaxBytesValue(String(Math.max(1, Math.ceil(currentBytes / (unit === "GB" ? ONE_GB : ONE_MB)))));
                  setRequestEditMaxBytesDirty(true);
                }}
                onRevoke={() => { setConfirmTarget({ type: "inbox", code: group.code }); setConfirmOpen(true); }}
                onDownloadGroup={() => void handleDownloadGroup(group)}
                onDownloadFile={(file) => void handleDownloadReceived(file)}
                canBatchSaveToDirectory={downloadConfig.smart_download_enabled && downloadConfig.filesystem_access_enabled && directoryDownloadSupported}
              />
            ))}
          </div>
        )}

        {totalForTab > PAGE_SIZE && (
          <div className="mt-6">
            <Pagination
              page={page}
              total={totalForTab}
              pageSize={PAGE_SIZE}
              onPageChange={(nextPage) => setQuery({ page: nextPage <= 1 ? null : nextPage })}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={confirmTarget?.type === "inbox" ? "撤销收件链接" : "撤销分享"}
        description={confirmTarget?.type === "inbox" ? "撤销后收件链接将失效，已收到文件会从收件箱移除且不能继续下载。确定要撤销吗？" : "撤销后链接将永久失效，无法恢复。确定要撤销吗？"}
        confirmText={confirmTarget?.type === "inbox" ? "撤销并移除文件" : "确定撤销"}
        danger
        onConfirm={handleRevoke}
        onCancel={() => { setConfirmOpen(false); setConfirmTarget(null); }}
      />

      {receivedDownloadProgress && (
        <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl overflow-hidden rounded-2xl border border-white/15 bg-white/90 p-3 shadow-2xl shadow-nyy-900/20 backdrop-blur-xl dark:bg-gray-950/90">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="rounded-full bg-nyy-500/10 px-2 py-0.5 type-caption font-medium text-nyy-600 dark:text-nyy-300">{receivedDownloadBatchLabel}</span>
                <p className="type-body-sm truncate font-semibold retro-text" title={receivedDownloadTitle}>{receivedDownloadTitle}</p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10" aria-hidden="true">
                <span className="block h-full rounded-full bg-nyy-500 transition-[width]" style={{ width: `${Math.max(receivedDownloadRatio * 100, receivedDownloadRatio > 0 ? 1.5 : 0)}%` }} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 type-caption retro-muted">
                <span>{formatSize(receivedDownloadProgress.downloadedBytes)} / {formatSize(receivedDownloadProgress.totalBytes)}</span>
                <span>{downloadPercent(receivedDownloadProgress)} · {formatSpeed(receivedDownloadProgress.bytesPerSecond)}</span>
              </div>
            </div>
            <button type="button" onClick={handleCancelReceivedDownload} className="retro-btn-secondary min-h-[44px] shrink-0 px-3 text-red-500 hover:text-red-500" aria-label="取消下载">
              <X className="h-4 w-4" />取消
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

interface ShareCardProps {
  share: MyShareItem;
  isEditing: boolean;
  editPassword: string;
  editClearPassword: boolean;
  editExpires: string;
  editMaxDownloads: string;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onEditPasswordChange: (value: string) => void;
  onEditClearPasswordChange: (value: boolean) => void;
  onEditExpiresChange: (value: string) => void;
  onEditMaxDownloadsChange: (value: string) => void;
  onCopy: () => void;
  onRevoke: () => void;
}

function StatusMenu({ value, onChange }: { value: StatusFilter; onChange: (value: StatusFilter) => void }) {
  const selected = STATUS_OPTIONS.find((option) => option.value === value) || STATUS_OPTIONS[0];

  return (
    <MenuTrigger>
      <Button
        className="retro-input type-body-sm flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-label={`筛选状态，当前：${selected.label}`}
      >
        <span>{selected.label}</span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </Button>
      <Popover placement="bottom end">
        <Menu
          selectionMode="single"
          selectedKeys={[value]}
          onSelectionChange={(selection) => {
            if (selection === "all") return;
            const key = Array.from(selection)[0] as StatusFilter | undefined;
            if (key && isStatusFilter(key)) onChange(key);
          }}
          className="retro-menu w-full min-w-44 rounded-2xl p-1"
        >
          {STATUS_OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              id={option.value}
              textValue={option.label}
              className="retro-menu-item type-action justify-between"
            >
              <span>{option.label}</span>
              {value === option.value && <Check className="h-4 w-4 text-nyy-500" />}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

interface WorkbenchAction {
  key: string;
  label: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  copy?: boolean;
}

function ActionMenu({ actions }: { actions: WorkbenchAction[] }) {
  return (
    <MenuTrigger>
      <Button
        className="retro-icon-button h-11 w-11"
        aria-label="操作"
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      <Popover placement="bottom end" offset={8} className="w-56 max-w-[calc(100vw-2rem)]">
        <Menu
          onAction={(key) => {
            const action = actions.find((a) => a.key === key);
            if (!action) return;
            action.onClick?.();
          }}
          className="retro-menu rounded-2xl p-1"
        >
          {actions.map((action) => {
            const itemClass = cn(
              "retro-menu-item type-action",
              action.danger && "retro-menu-item-danger"
            );
            return (
              <MenuItem
                key={action.key}
                id={action.key}
                href={action.href && !action.disabled ? action.href : undefined}
                target={action.href ? "_blank" : undefined}
                rel={action.href ? "noopener noreferrer" : undefined}
                isDisabled={action.disabled}
                textValue={action.label}
                className={itemClass}
              >
                {action.icon}{action.label}
              </MenuItem>
            );
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

function ShareCard({ share, isEditing, editPassword, editClearPassword, editExpires, editMaxDownloads, onEditStart, onEditCancel, onEditSave, onEditPasswordChange, onEditClearPasswordChange, onEditExpiresChange, onEditMaxDownloadsChange, onCopy, onRevoke }: ShareCardProps) {
  const status = getShareStatus(share);
  const isActive = status === "active";
  const previewFiles = share.preview_files || [];
  const hiddenFileCount = Math.max(0, share.file_count - previewFiles.length);
  const actions: WorkbenchAction[] = [
    { key: "copy", label: "复制链接", icon: <Copy className="h-4 w-4" />, onClick: onCopy, copy: true },
    { key: "open", label: "打开分享", icon: <ExternalLink className="h-4 w-4" />, href: `/${share.code}` },
  ];
  if (isActive) {
    actions.push(
      { key: "edit", label: "编辑设置", icon: <Pencil className="h-4 w-4" />, onClick: onEditStart },
      { key: "revoke", label: "撤销分享", icon: <Trash2 className="h-4 w-4" />, onClick: onRevoke, danger: true }
    );
  }

  return (
    <article className="retro-card relative min-w-0 overflow-hidden p-4 sm:p-5">
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 pr-12 sm:pr-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-mono text-lg font-bold text-nyy-500">/{share.code}</span>
            <StatusBadge status={status} />
            {share.has_password && <span className="retro-chip"><Lock className="mr-1 h-3 w-3" /> 提取码</span>}
          </div>
          <div className="mt-3 grid min-w-0 gap-2">
            <p className="type-body-sm retro-text">
              {share.file_count > 0 ? `包含 ${share.file_count} 个文件` : "没有文件"}
              {share.empty_dir_count > 0 && ` · ${share.empty_dir_count} 个空文件夹`}
            </p>
            {previewFiles.length > 0 ? (
              <div className="flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
                {previewFiles.map((name) => (
                  <span key={name} className="min-w-0 max-w-full truncate rounded-lg border border-white/10 bg-white/5 px-2 py-1 type-caption retro-text sm:max-w-[14rem]">
                    {name}
                  </span>
                ))}
                {hiddenFileCount > 0 && <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 type-caption retro-muted">等 {hiddenFileCount} 个</span>}
              </div>
            ) : (
              <p className="type-caption retro-muted">打开分享页可查看完整文件列表</p>
            )}
            <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 overflow-hidden type-caption retro-muted">
              <span className="min-w-0">{formatSize(share.total_bytes)}</span>
              <span className="min-w-0">创建 {formatDate(share.created_at)}</span>
              <span className="min-w-0">{share.expires_at ? `到期 ${formatDate(share.expires_at)}` : "永不过期"}</span>
              <span className="min-w-0">{share.last_downloaded_at ? `最近下载 ${formatDate(share.last_downloaded_at)}` : "暂无下载"}</span>
              <span className={`inline-flex rounded-full border px-2 py-0.5 ${downloadClass(share.download_count, share.max_downloads)}`}>{downloadLabel(share.download_count, share.max_downloads)}</span>
            </div>
          </div>
        </div>
        <div className="absolute right-4 top-4 sm:hidden">
          <ActionMenu actions={actions} />
        </div>
        <div className="hidden flex-wrap gap-2 sm:flex lg:justify-end">
          <CopyLinkButton onCopy={onCopy} className="retro-btn-secondary min-h-[44px] px-3" title="复制链接" />
          <a href={`/${share.code}`} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[44px] px-3" title="打开分享"><ExternalLink className="h-4 w-4" />打开</a>
          {isActive && <button onClick={onEditStart} className="retro-btn-secondary min-h-[44px] px-3" title="编辑"><Pencil className="h-4 w-4" />编辑</button>}
          {isActive && <button onClick={onRevoke} className="retro-btn-secondary min-h-[44px] px-3 text-red-500 hover:text-red-500" title="撤销"><Trash2 className="h-4 w-4" />撤销</button>}
        </div>
      </div>

      {isEditing && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="type-label retro-text">提取码</span>
              <input
                type="text"
                value={editPassword}
                onChange={(event) => onEditPasswordChange(event.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder={editClearPassword ? "将清除提取码" : "留空不修改"}
                disabled={editClearPassword}
                className="retro-input type-body-sm mt-1.5 w-full px-3"
              />
              {share.has_password && (
                <label className="mt-2 flex items-center gap-2 type-caption retro-muted">
                  <input
                    type="checkbox"
                    checked={editClearPassword}
                    onChange={(event) => onEditClearPasswordChange(event.target.checked)}
                    className="h-4 w-4 rounded border-white/20 accent-nyy-500"
                  />
                  清除当前提取码
                </label>
              )}
            </label>
            <label className="block">
              <span className="type-label retro-text">有效期</span>
              <select value={editExpires} onChange={(event) => onEditExpiresChange(event.target.value)} className="retro-input type-body-sm mt-1.5 w-full px-3">
                <option value="keep">保持不变</option>
                <option value="0">永不过期</option>
                <option value="1">1 小时</option>
                <option value="24">1 天</option>
                <option value="168">7 天</option>
                <option value="720">30 天</option>
              </select>
            </label>
            <label className="block">
              <span className="type-label retro-text">下载次数</span>
              <select value={editMaxDownloads} onChange={(event) => onEditMaxDownloadsChange(event.target.value)} className="retro-input type-body-sm mt-1.5 w-full px-3">
                {!editMaxDownloads && <option value="" disabled>选择新的下载次数</option>}
                {DOWNLOAD_OPTIONS.map((value) => <option key={value} value={value}>{value === 0 ? "不限" : `${value} 次`}</option>)}
              </select>
              {!editMaxDownloads && <p className="type-caption mt-1.5 text-amber-500">当前上限是旧规则，请选择新的下载次数。</p>}
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={onEditSave} className="btn-primary min-h-[44px] px-4"><Check className="h-4 w-4" />保存</button>
            <button onClick={onEditCancel} className="retro-btn-secondary min-h-[44px] px-4"><X className="h-4 w-4" />取消</button>
          </div>
        </div>
      )}
    </article>
  );
}

interface InboxGroupCardProps {
  group: MyInboxGroup;
  expanded: boolean;
  downloading: boolean;
  isEditing: boolean;
  editTitle: string;
  editPassword: string;
  editClearPassword: boolean;
  editExtendHours: string;
  editMaxFiles: string;
  editMaxBytesValue: string;
  editMaxBytesUnit: SizeUnit;
  onToggle: () => void;
  onCopy: () => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onEditTitleChange: (value: string) => void;
  onEditPasswordChange: (value: string) => void;
  onEditClearPasswordChange: (value: boolean) => void;
  onEditExtendHoursChange: (value: string) => void;
  onEditMaxFilesChange: (value: string) => void;
  onEditMaxBytesValueChange: (value: string) => void;
  onEditMaxBytesUnitChange: (value: SizeUnit) => void;
  onRevoke: () => void;
  onDownloadGroup: () => void;
  onDownloadFile: (file: MyRequestFileItem) => void;
  canBatchSaveToDirectory: boolean;
}

function InboxGroupCard({ group, expanded, downloading, isEditing, editTitle, editPassword, editClearPassword, editExtendHours, editMaxFiles, editMaxBytesValue, editMaxBytesUnit, onToggle, onCopy, onEditStart, onEditCancel, onEditSave, onEditTitleChange, onEditPasswordChange, onEditClearPasswordChange, onEditExtendHoursChange, onEditMaxFilesChange, onEditMaxBytesValueChange, onEditMaxBytesUnitChange, onRevoke, onDownloadGroup, onDownloadFile, canBatchSaveToDirectory }: InboxGroupCardProps) {
  const status = getInboxStatus(group);
  const isActive = status === "active";
  const isRevoked = status === "revoked";
  const fileProgress = group.max_files > 0 ? Math.min(100, (group.file_count / group.max_files) * 100) : 0;
  const bytesProgress = group.max_bytes > 0 ? Math.min(100, (group.total_bytes / group.max_bytes) * 100) : 0;
  const actions: WorkbenchAction[] = [
    { key: "copy", label: "复制链接", icon: <Copy className="h-4 w-4" />, onClick: onCopy, copy: true },
    { key: "open", label: "打开收件", icon: <ExternalLink className="h-4 w-4" />, href: `/r/${group.code}` },
  ];
  if (isActive) actions.push({ key: "edit", label: "编辑设置", icon: <Pencil className="h-4 w-4" />, onClick: onEditStart });
  if (!isRevoked) actions.push({ key: "revoke", label: "撤销收件", icon: <Trash2 className="h-4 w-4" />, onClick: onRevoke, danger: true });
  const batchDownloadLabel = canBatchSaveToDirectory ? (downloading ? "保存中" : "保存到文件夹") : "请逐个下载";
  actions.push(
    { key: "pack", label: batchDownloadLabel, icon: <Package className="h-4 w-4" />, onClick: onDownloadGroup, disabled: downloading || group.files.length === 0 },
    { key: "toggle", label: expanded ? "收起文件" : "展开文件", icon: <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />, onClick: onToggle }
  );

  return (
    <article className="retro-card relative min-w-0 overflow-hidden p-4 sm:p-5">
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 pr-12 sm:pr-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="retro-title min-w-0 truncate text-lg">{group.title}</span>
            <span className="min-w-0 truncate font-mono type-body-sm text-nyy-500">/r/{group.code}</span>
            <StatusBadge status={status} />
            {group.has_password && <span className="retro-chip"><Lock className="mr-1 h-3 w-3" /> 访问码</span>}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 overflow-hidden type-caption retro-muted">
            <span className="inline-flex min-w-0 items-center gap-1"><Inbox className="h-3.5 w-3.5 shrink-0" /> 已收 {group.file_count} / {group.max_files} 个文件</span>
            <span className="min-w-0">{formatSize(group.total_bytes)} / {formatSize(group.max_bytes)}</span>
            <span className="inline-flex min-w-0 items-center gap-1"><Clock className="h-3.5 w-3.5 shrink-0" /> {group.expires_at ? `到期 ${formatDate(group.expires_at)}` : "永不过期"}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex justify-between gap-2 type-caption retro-muted">
                <span>文件名额</span><span>剩余 {Math.max(0, group.max_files - group.file_count)} 个</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <span className="block h-full rounded-full bg-nyy-500" style={{ width: `${fileProgress}%` }} />
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between gap-2 type-caption retro-muted">
                <span>收件容量</span><span>剩余 {formatSize(Math.max(0, group.max_bytes - group.total_bytes))}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <span className="block h-full rounded-full bg-nyy-500" style={{ width: `${bytesProgress}%` }} />
              </div>
            </div>
          </div>
        </div>
        <div className="absolute right-4 top-4 sm:hidden">
          <ActionMenu actions={actions} />
        </div>
        <div className="hidden flex-wrap gap-2 sm:flex lg:justify-end">
          <CopyLinkButton onCopy={onCopy} className="retro-btn-secondary min-h-[44px] px-3" />
          <a href={`/r/${group.code}`} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[44px] px-3"><ExternalLink className="h-4 w-4" />打开</a>
          {isActive && <button onClick={onEditStart} className="retro-btn-secondary min-h-[44px] px-3"><Pencil className="h-4 w-4" />编辑</button>}
          {!isRevoked && <button onClick={onRevoke} className="retro-btn-secondary min-h-[44px] px-3 text-red-500 hover:text-red-500"><Trash2 className="h-4 w-4" />撤销</button>}
          <button onClick={onDownloadGroup} disabled={downloading || group.files.length === 0} className="retro-btn-secondary min-h-[44px] px-3"><Package className="h-4 w-4" />{batchDownloadLabel}</button>
          <button onClick={onToggle} className="retro-btn-secondary min-h-[44px] px-3"><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />{expanded ? "收起" : "展开"}</button>
        </div>
      </div>

      {isEditing && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="type-label retro-text">收件标题</span>
              <input
                type="text"
                value={editTitle}
                onChange={(event) => onEditTitleChange(event.target.value)}
                className="retro-input type-body-sm mt-1.5 w-full px-3"
              />
            </label>
            <label className="block">
              <span className="type-label retro-text">访问码</span>
              <input
                type="text"
                value={editPassword}
                onChange={(event) => onEditPasswordChange(event.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder={editClearPassword ? "将清除访问码" : "留空不修改"}
                disabled={editClearPassword}
                inputMode="numeric"
                className="retro-input type-body-sm mt-1.5 w-full px-3"
              />
              {group.has_password && (
                <label className="mt-2 flex items-center gap-2 type-caption retro-muted">
                  <input
                    type="checkbox"
                    checked={editClearPassword}
                    onChange={(event) => onEditClearPasswordChange(event.target.checked)}
                    className="h-4 w-4 rounded border-white/20 accent-nyy-500"
                  />
                  清除当前访问码
                </label>
              )}
            </label>
            <label className="block">
              <span className="type-label retro-text">有效期</span>
              <select value={editExtendHours} onChange={(event) => onEditExtendHoursChange(event.target.value)} className="retro-input type-body-sm mt-1.5 w-full px-3">
                <option value="keep">保持不变</option>
                <option value="24">延长 1 天</option>
                <option value="168">延长 7 天</option>
                <option value="720">延长 30 天</option>
              </select>
            </label>
            <label className="block">
              <span className="type-label retro-text">最大文件数</span>
              <input
                type="number"
                min={Math.max(1, group.file_count)}
                max={100}
                value={editMaxFiles}
                onChange={(event) => onEditMaxFilesChange(event.target.value)}
                className="retro-input type-body-sm mt-1.5 w-full px-3"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="type-label retro-text">容量上限</span>
              <div className="retro-input mt-1.5 flex overflow-hidden p-0 focus-within:border-nyy-600">
                <input
                  type="number"
                  min={1}
                  max={editMaxBytesUnit === "GB" ? 1 : 1024}
                  value={editMaxBytesValue}
                  onChange={(event) => onEditMaxBytesValueChange(event.target.value)}
                  className="type-body-sm min-h-[42px] min-w-0 flex-1 bg-transparent px-3 outline-none"
                />
                <select
                  value={editMaxBytesUnit}
                  onChange={(event) => onEditMaxBytesUnitChange(event.target.value as SizeUnit)}
                  className="type-caption border-l border-white/10 bg-transparent px-3 retro-text outline-none"
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
              <p className="type-caption mt-1.5 retro-muted">可降低，但不能低于当前已收到容量。</p>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={onEditSave} className="btn-primary min-h-[44px] px-4"><Check className="h-4 w-4" />保存</button>
            <button onClick={onEditCancel} className="retro-btn-secondary min-h-[44px] px-4"><X className="h-4 w-4" />取消</button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="mt-4 border-t border-white/10 pt-4">
          {group.files.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center">
              <p className="type-body-sm retro-text">暂未收到文件</p>
              <p className="type-caption mt-1 retro-muted">复制收件链接发给对方，对方上传后会显示在这里。</p>
            </div>
          ) : (
            <div className="grid gap-2">
              {group.files.map((file) => (
                <div key={file.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nyy-500/10 text-nyy-500">
                      <FileText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="type-file-name truncate font-medium retro-text">{file.file_name}</p>
                      <p className="type-caption retro-muted">{formatSize(file.file_size)} · {formatDate(file.created_at)}</p>
                    </div>
                  </div>
                  <button onClick={() => onDownloadFile(file)} className="retro-btn-secondary min-h-[44px] px-3 sm:shrink-0">
                    <Download className="h-4 w-4" />下载
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
