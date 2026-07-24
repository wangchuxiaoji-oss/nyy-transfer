"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { AlertCircle, CheckCircle2, Clock, Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import {
  cancelDoubaoQR,
  cancelDoubaoTestBQR,
  getDoubaoQRStatus,
  getDoubaoSessionStatus,
  getDoubaoTestBQRStatus,
  getDoubaoTestBSessionStatus,
  startDoubaoQR,
  startDoubaoTestBQR,
  type DoubaoSessionStatus,
} from "@/lib/admin";
import { getErrorMessage } from "@/lib/errors";
import { formatAdminDate, formatRelativeTime } from "./admin-ui";

interface DoubaoEndpoints {
  load: (probe?: boolean) => Promise<DoubaoSessionStatus>;
  start: () => Promise<{ qr_base64: string; message?: string }>;
  status: () => Promise<{ status: string; message: string }>;
  cancel: () => Promise<{ message: string }>;
}

const PRODUCTION_ENDPOINTS: DoubaoEndpoints = { load: getDoubaoSessionStatus, start: startDoubaoQR, status: getDoubaoQRStatus, cancel: cancelDoubaoQR };
const TEST_B_ENDPOINTS: DoubaoEndpoints = { load: getDoubaoTestBSessionStatus, start: startDoubaoTestBQR, status: getDoubaoTestBQRStatus, cancel: cancelDoubaoTestBQR };
const ACTIVE_QR_STATES = new Set(["fetching_qr", "waiting_scan", "scanned"]);

export function AdminDoubaoPanel() {
  return <DoubaoSessionPanel endpoints={PRODUCTION_ENDPOINTS} title="生产 Session" description="上传与公开下载链路使用的正式凭据。" qrAlt="豆包登录二维码" />;
}

export function AdminDoubaoTestPanel() {
  return <DoubaoSessionPanel endpoints={TEST_B_ENDPOINTS} title="B 账号测试 Session" description="互读实验专用，不覆盖生产 Session。" qrAlt="B 账号豆包二维码" />;
}

function DoubaoSessionPanel({ endpoints, title, description, qrAlt }: { endpoints: DoubaoEndpoints; title: string; description: string; qrAlt: string }) {
  const [session, setSession] = useState<DoubaoSessionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [qrBase64, setQrBase64] = useState("");
  const [qrStatus, setQrStatus] = useState("idle");
  const [qrMessage, setQrMessage] = useState("");
  const [countdown, setCountdown] = useState(0);

  const load = useCallback(async (probe = false) => {
    setLoading(true);
    setError("");
    try {
      setSession(await endpoints.load(probe));
    } catch (loadError) {
      setError(getErrorMessage(loadError, "豆包 Session 加载失败"));
    } finally {
      setLoading(false);
    }
  }, [endpoints]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!ACTIVE_QR_STATES.has(qrStatus)) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await endpoints.status();
        if (cancelled) return;
        setQrStatus(result.status);
        setQrMessage(result.message);
        if (result.status === "confirmed") {
          setQrBase64("");
          setCountdown(0);
          await load(true);
          return;
        }
        if (["expired", "error", "idle"].includes(result.status)) {
          setQrBase64("");
          setCountdown(0);
          return;
        }
      } catch (pollError) {
        if (!cancelled) setQrMessage(getErrorMessage(pollError, "扫码状态加载失败，将继续重试"));
      }
      if (!cancelled) timer = window.setTimeout(poll, 1800);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [endpoints, load, qrStatus]);

  useEffect(() => {
    if (countdown <= 0 || !ACTIVE_QR_STATES.has(qrStatus)) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown, qrStatus]);

  const start = async () => {
    if (pending) return;
    setPending(true);
    setQrStatus("fetching_qr");
    setQrMessage("正在获取二维码...");
    try {
      const result = await endpoints.start();
      setQrBase64(result.qr_base64);
      setQrStatus("waiting_scan");
      setQrMessage(result.message || "等待扫码确认");
      setCountdown(120);
    } catch (startError) {
      setQrStatus("error");
      setQrMessage(getErrorMessage(startError, "二维码获取失败"));
    } finally {
      setPending(false);
    }
  };

  const cancel = async () => {
    if (pending) return;
    setPending(true);
    try { await endpoints.cancel(); } catch (cancelError) { setQrMessage(getErrorMessage(cancelError, "取消失败")); }
    finally { setQrBase64(""); setQrStatus("idle"); setCountdown(0); setPending(false); }
  };

  const usable = Boolean(session?.has_session && session.usable);
  const statusLabel = !session?.has_session ? "无 Session" : session.verified ? usable ? "可用" : "不可用" : "待验证";
  return (
    <div className="space-y-5" data-testid="admin-doubao-panel">
      <section className="retro-panel p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="retro-kicker">TOS 存储</p><h2 className="retro-title mt-1 text-xl">{title}</h2><p className="mt-1 type-caption retro-muted">{description}</p></div><button type="button" onClick={() => void load(true)} disabled={loading} className="retro-btn-secondary px-3 type-caption"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />验证可用性</button></div>
        {loading && !session ? <div className="flex min-h-32 items-center justify-center gap-2 retro-muted"><Loader2 className="h-5 w-5 animate-spin" />加载 Session...</div> : error ? <div className="mt-5 rounded-xl border border-red-300/40 bg-red-50 p-4 dark:bg-red-500/10"><p className="flex items-center gap-2 type-body-sm text-red-700 dark:text-red-200"><AlertCircle className="h-4 w-4" />{error}</p><button type="button" onClick={() => void load()} className="retro-btn-secondary mt-3 px-3 type-caption">重试加载</button></div> : session && <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><StatusCard label="当前状态" value={statusLabel} detail={session.check_message || "以主动验证结果为准"} tone={usable ? "text-emerald-600 dark:text-emerald-300" : session.has_session ? "text-amber-700 dark:text-amber-200" : "text-red-600 dark:text-red-300"} /><StatusCard label="最近验证" value={formatRelativeTime(session.last_probe_success_at || session.last_probe_at)} detail={formatSessionTime(session.last_probe_success_at || session.last_probe_at)} /><StatusCard label="预计到期" value={session.sid_guard_expires_in_hours === null || session.sid_guard_expires_in_hours === undefined ? "未记录" : session.sid_guard_expires_in_hours > 0 ? `${session.sid_guard_expires_in_hours} 小时后` : "已到期"} detail={formatSessionTime(session.sid_guard_expires_at)} /><StatusCard label="最近错误" value={session.last_probe_error || session.last_heartbeat_error ? "需要关注" : "无"} detail={session.last_probe_error || session.last_heartbeat_error || `刷新于 ${formatSessionTime(session.last_refresh)}`} tone={session.last_probe_error || session.last_heartbeat_error ? "text-red-600 dark:text-red-300" : undefined} /></div>}
      </section>

      <section className="retro-panel p-4 sm:p-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start"><div><p className="retro-kicker">移动流程</p><h3 className="retro-title mt-1 text-lg">刷新 Session</h3><ol className="mt-4 grid gap-2 type-body-sm retro-text"><li className="rounded-xl border border-black/8 p-3 dark:border-white/10">1. 点击开始刷新，服务端生成短效二维码</li><li className="rounded-xl border border-black/8 p-3 dark:border-white/10">2. 用另一台设备扫码，或将二维码保存后用系统相册识别</li><li className="rounded-xl border border-black/8 p-3 dark:border-white/10">3. 在豆包 App 确认，页面自动轮询并显示保存结果</li></ol><p className="mt-3 flex items-start gap-2 type-caption text-amber-800 dark:text-amber-200"><Smartphone className="mt-0.5 h-4 w-4 shrink-0" />同一手机无法直接扫描当前屏幕，请使用第二设备或系统相册识别。</p>{!ACTIVE_QR_STATES.has(qrStatus) && qrStatus !== "confirmed" && <button type="button" onClick={() => void start()} disabled={pending} className="btn-primary mt-4"><QrCode className="h-4 w-4" />{pending ? "获取中..." : qrStatus === "error" || qrStatus === "expired" ? "重新获取二维码" : "开始刷新"}</button>}</div>
          <div className="min-h-[250px] rounded-2xl border border-black/8 bg-white/45 p-4 text-center dark:border-white/10 dark:bg-white/[0.035]">{qrBase64 ? <><div className="mx-auto w-fit rounded-xl bg-white p-2"><Image src={`data:image/png;base64,${qrBase64}`} alt={qrAlt} width={192} height={192} unoptimized className="h-48 w-48" /></div><p className="mt-3 type-body-sm font-semibold retro-text">{qrMessage}</p><p className="mt-1 flex items-center justify-center gap-1 type-caption retro-muted"><Clock className="h-3.5 w-3.5" />建议 {countdown} 秒内完成</p><button type="button" onClick={() => void cancel()} disabled={pending} className="retro-btn-secondary mt-3 w-full type-caption">取消扫码</button></> : qrStatus === "confirmed" ? <div className="flex min-h-[218px] flex-col items-center justify-center gap-3 text-emerald-600 dark:text-emerald-300"><CheckCircle2 className="h-10 w-10" /><p className="type-body-sm font-semibold">Session 已保存</p></div> : <div className="flex min-h-[218px] flex-col items-center justify-center gap-3 retro-muted"><QrCode className="h-10 w-10" /><p className="type-body-sm">{qrMessage || "二维码将在这里显示"}</p></div>}</div>
        </div>
      </section>
    </div>
  );
}

function formatSessionTime(value?: string | null): string {
  if (!value) return "未记录";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatAdminDate(parsed.toISOString());
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: string }) {
  return <div className="retro-card p-4"><p className="type-caption retro-muted">{label}</p><p className={`mt-2 type-body-sm font-semibold ${tone || "retro-text"}`}>{value}</p><p className="mt-1 break-words text-[10px] retro-muted" title={detail}>{detail}</p></div>;
}
