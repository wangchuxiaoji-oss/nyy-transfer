"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { X, Eye, EyeOff, ArrowLeft, Mail, KeyRound, ShieldCheck } from "lucide-react";
import {
  sendCode,
  register,
  verifyEmail,
  login,
  resetPassword,
  type UserInfo,
} from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { BrandLogo } from "@/components/brand-logo";

type Tab = "login" | "register" | "forgot";
type RegisterStep = "email" | "verify";
type ForgotStep = "email" | "reset";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onLoginSuccess: (user: UserInfo) => void;
}

function getPasswordStrength(pw: string): { level: number; label: string; color: string } {
  if (!pw) return { level: 0, label: "", color: "" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { level: 1, label: "弱", color: "bg-red-400" };
  if (score <= 3) return { level: 2, label: "中", color: "bg-yellow-400" };
  return { level: 3, label: "强", color: "bg-green-500" };
}

export function AuthModal({ open, onClose, onLoginSuccess }: AuthModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  // Login state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Register state
  const [regStep, setRegStep] = useState<RegisterStep>("email");
  const [regEmail, setRegEmail] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Forgot password state
  const [forgotStep, setForgotStep] = useState<ForgotStep>("email");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotCountdown, setForgotCountdown] = useState(0);

  const resetState = useCallback(() => {
    setError("");
    setLoading(false);
    setSuccessMsg("");
    setRegStep("email");
    setForgotStep("email");
    setCountdown(0);
    setForgotCountdown(0);
    setShowPassword(false);
  }, []);

  // Focus trap & Escape
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusFirst = () => {
      const el = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      el?.focus();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    requestAnimationFrame(focusFirst);
    return () => { document.removeEventListener("keydown", handleKey); previousFocus?.focus?.(); };
  }, [open, onClose]);

  const switchTab = (t: Tab) => { setTab(t); resetState(); };

  const startCountdown = (setter: React.Dispatch<React.SetStateAction<number>>) => {
    setter(60);
    const timer = setInterval(() => {
      setter((c) => { if (c <= 1) { clearInterval(timer); return 0; } return c - 1; });
    }, 1000);
  };

  // --- Handlers ---
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await login(loginEmail, loginPassword);
      const { getMe } = await import("@/lib/auth");
      const user = await getMe();
      onLoginSuccess(user); onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "登录失败"));
    } finally { setLoading(false); }
  };

  const handleSendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(""); setLoading(true);
    try {
      await sendCode(regEmail, "register");
      setRegStep("verify"); startCountdown(setCountdown);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "发送失败"));
    } finally { setLoading(false); }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreedTerms) { setError("请同意服务条款"); return; }
    setError(""); setLoading(true);
    try {
      await verifyEmail(regEmail, regCode);
      await register(regEmail, regPassword);
      await login(regEmail, regPassword);
      const { getMe } = await import("@/lib/auth");
      const user = await getMe();
      onLoginSuccess(user); onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "注册失败"));
    } finally { setLoading(false); }
  };

  const handleForgotSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await sendCode(forgotEmail, "reset_password");
      setForgotStep("reset"); startCountdown(setForgotCountdown);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "发送失败"));
    } finally { setLoading(false); }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await resetPassword(forgotEmail, forgotCode, forgotPassword);
      setSuccessMsg("密码重置成功，请登录");
      setTimeout(() => { switchTab("login"); setSuccessMsg(""); }, 1500);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "重置失败"));
    } finally { setLoading(false); }
  };

  const pwStrength = getPasswordStrength(tab === "register" ? regPassword : forgotPassword);

  if (!open) return null;

  // Shared input class
  const inputCls = "type-body-sm min-h-[44px] w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-white/5 px-4 py-3 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-nyy-500 focus:outline-none focus:ring-1 focus:ring-nyy-500/30 transition";
  const btnPrimary = "min-h-[44px] w-full rounded-xl bg-gradient-to-br from-[#FF8A3D] to-[#e0652a] py-3 font-semibold text-white shadow-[0_2px_12px_rgba(255,138,61,0.35)] transition-all hover:shadow-[0_4px_20px_rgba(255,138,61,0.45)] hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[52rem] overflow-hidden rounded-3xl bg-white dark:bg-[#1a1a1a] shadow-2xl"
      >
        {/* Left brand panel */}
        <div className="hidden sm:flex w-[14rem] flex-col justify-between bg-gradient-to-b from-[#1a1008] to-[#0d0a06] p-8">
          <div>
            <BrandLogo className="h-auto w-32" />
            <p className="type-label mt-4 text-orange-100/90">想传文件？拿呀呀</p>
            <div className="mt-6 space-y-3">
              <Feature icon={<Mail className="h-4 w-4" />} text="注册即享 1 GB 配额" />
              <Feature icon={<ShieldCheck className="h-4 w-4" />} text="管理你的分享" />
              <Feature icon={<KeyRound className="h-4 w-4" />} text="更长有效期" />
            </div>
          </div>
          <p className="type-caption text-orange-200/40">nyy.app &copy; 2026</p>
        </div>

        {/* Right form panel */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8">
          <button onClick={onClose} aria-label="关闭" className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 transition">
            <X size={20} />
          </button>

          {/* Tabs */}
          {tab !== "forgot" ? (
            <div className="mb-6 flex gap-1 rounded-2xl bg-gray-100 dark:bg-white/5 p-1 mr-10" role="tablist">
              <button onClick={() => switchTab("login")} role="tab" aria-selected={tab === "login"}
                className={`type-action flex-1 rounded-xl py-2.5 transition ${tab === "login" ? "bg-white dark:bg-white/10 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"}`}>
                登录
              </button>
              <button onClick={() => switchTab("register")} role="tab" aria-selected={tab === "register"}
                className={`type-action flex-1 rounded-xl py-2.5 transition ${tab === "register" ? "bg-white dark:bg-white/10 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"}`}>
                注册
              </button>
            </div>
          ) : (
            <button onClick={() => switchTab("login")} className="type-action mb-6 flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition">
              <ArrowLeft className="h-4 w-4" /> 返回登录
            </button>
          )}

          <h2 id="auth-modal-title" className="sr-only">账号登录与注册</h2>

          {error && <div role="alert" className="type-body-sm mb-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/30 p-3 text-red-700 dark:text-red-400">{error}</div>}
          {successMsg && <div className="type-body-sm mb-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800/30 p-3 text-green-700 dark:text-green-400">{successMsg}</div>}

          {/* Login Form */}
          {tab === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="login-email" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">邮箱</label>
                <input id="login-email" type="email" autoComplete="email" placeholder="your@email.com" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required className={inputCls} />
              </div>
              <div>
                <label htmlFor="login-password" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">密码</label>
                <div className="relative">
                  <input id="login-password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="输入密码" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required className={`${inputCls} pr-12`} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={loading} className={btnPrimary}>
                {loading ? "登录中..." : "登录"}
              </button>
              <button type="button" onClick={() => switchTab("forgot")} className="type-action w-full text-center text-gray-500 dark:text-gray-400 hover:text-nyy-600 dark:hover:text-nyy-400 transition">
                忘记密码？
              </button>
            </form>
          )}

          {/* Register - Step 1: Email */}
          {tab === "register" && regStep === "email" && (
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label htmlFor="reg-email" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">邮箱</label>
                <input id="reg-email" type="email" autoComplete="email" placeholder="your@email.com" value={regEmail} onChange={(e) => setRegEmail(e.target.value)} required className={inputCls} />
              </div>
              <button type="submit" disabled={loading} className={btnPrimary}>
                {loading ? "发送中..." : "发送验证码"}
              </button>
            </form>
          )}

          {/* Register - Step 2: Verify + Password */}
          {tab === "register" && regStep === "verify" && (
            <form onSubmit={handleRegister} className="space-y-4">
              <p className="type-body-sm text-gray-600 dark:text-gray-400">
                验证码已发送至 <span className="font-medium text-gray-800 dark:text-gray-200">{regEmail}</span>
              </p>
              <div>
                <label htmlFor="reg-code" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">验证码</label>
                <input id="reg-code" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位数字" value={regCode} onChange={(e) => setRegCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required maxLength={6} className={`${inputCls} type-section text-center tracking-[0.3em]`} />
              </div>
              <div>
                <label htmlFor="reg-pw" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">设置密码</label>
                <div className="relative">
                  <input id="reg-pw" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="至少 8 位" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} required minLength={8} className={`${inputCls} pr-12`} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              {/* Password strength */}
              {regPassword && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800">
                    <div className={`h-full rounded-full transition-all ${pwStrength.color}`} style={{ width: `${(pwStrength.level / 3) * 100}%` }} />
                  </div>
                  <span className="type-caption text-gray-500">{pwStrength.label}</span>
                </div>
              )}
              {/* Terms */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={agreedTerms} onChange={(e) => setAgreedTerms(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-nyy-600 focus:ring-nyy-500" />
                <span className="type-caption text-gray-500 dark:text-gray-400">
                  我已阅读并同意 <a href="/terms" target="_blank" className="text-nyy-600 dark:text-nyy-400 hover:underline">服务条款</a> 和 <a href="/privacy" target="_blank" className="text-nyy-600 dark:text-nyy-400 hover:underline">隐私政策</a>
                </span>
              </label>
              <button type="submit" disabled={loading || regCode.length < 6 || regPassword.length < 8 || !agreedTerms} className={btnPrimary}>
                {loading ? "注册中..." : "注册"}
              </button>
              <button type="button" disabled={countdown > 0} onClick={() => handleSendCode()} className="type-action min-h-[44px] w-full text-nyy-600 dark:text-nyy-400 hover:text-nyy-700 disabled:text-gray-400 dark:disabled:text-gray-600 transition">
                {countdown > 0 ? `${countdown}s 后重新发送` : "重新发送验证码"}
              </button>
            </form>
          )}

          {/* Forgot Password - Step 1: Email */}
          {tab === "forgot" && forgotStep === "email" && (
            <form onSubmit={handleForgotSendCode} className="space-y-4">
              <h3 className="type-section text-gray-900 dark:text-gray-100">重置密码</h3>
              <p className="type-body-sm text-gray-500 dark:text-gray-400">输入注册邮箱，我们将发送验证码。</p>
              <div>
                <label htmlFor="forgot-email" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">邮箱</label>
                <input id="forgot-email" type="email" autoComplete="email" placeholder="your@email.com" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required className={inputCls} />
              </div>
              <button type="submit" disabled={loading} className={btnPrimary}>
                {loading ? "发送中..." : "发送验证码"}
              </button>
            </form>
          )}

          {/* Forgot Password - Step 2: Code + New Password */}
          {tab === "forgot" && forgotStep === "reset" && (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <h3 className="type-section text-gray-900 dark:text-gray-100">设置新密码</h3>
              <p className="type-body-sm text-gray-500 dark:text-gray-400">
                验证码已发送至 <span className="font-medium text-gray-800 dark:text-gray-200">{forgotEmail}</span>
              </p>
              <div>
                <label htmlFor="forgot-code" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">验证码</label>
                <input id="forgot-code" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位数字" value={forgotCode} onChange={(e) => setForgotCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required maxLength={6} className={`${inputCls} type-section text-center tracking-[0.3em]`} />
              </div>
              <div>
                <label htmlFor="forgot-pw" className="type-label mb-1.5 block text-gray-600 dark:text-gray-400">新密码</label>
                <div className="relative">
                  <input id="forgot-pw" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="至少 8 位" value={forgotPassword} onChange={(e) => setForgotPassword(e.target.value)} required minLength={8} className={`${inputCls} pr-12`} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              {forgotPassword && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800">
                    <div className={`h-full rounded-full transition-all ${pwStrength.color}`} style={{ width: `${(pwStrength.level / 3) * 100}%` }} />
                  </div>
                  <span className="type-caption text-gray-500">{pwStrength.label}</span>
                </div>
              )}
              <button type="submit" disabled={loading || forgotCode.length < 6 || forgotPassword.length < 8} className={btnPrimary}>
                {loading ? "重置中..." : "重置密码"}
              </button>
              <button type="button" disabled={forgotCountdown > 0} onClick={() => { setForgotStep("email"); }} className="type-action min-h-[44px] w-full text-nyy-600 dark:text-nyy-400 hover:text-nyy-700 disabled:text-gray-400 dark:disabled:text-gray-600 transition">
                {forgotCountdown > 0 ? `${forgotCountdown}s 后可重新发送` : "重新发送验证码"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/* Feature bullet for left panel */
function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2.5 text-orange-100/80">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/15">{icon}</div>
      <span className="type-caption">{text}</span>
    </div>
  );
}
