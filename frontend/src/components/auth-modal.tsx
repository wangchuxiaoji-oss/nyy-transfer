"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, Mail, ShieldCheck, Sparkles, X } from "lucide-react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import {
  getMe,
  login,
  register,
  resetPassword,
  sendCode,
  type UserInfo,
} from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { BrandLogo } from "@/components/brand-logo";
import { CaptchaChallenge } from "@/components/captcha-challenge";
import { EmailCodeInput } from "@/components/email-code-input";

type Tab = "login" | "register" | "forgot";
type RegisterStep = "email" | "password" | "complete";
type ForgotStep = "email" | "password" | "complete";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onLoginSuccess: (user: UserInfo) => void;
}

const inputCls = "h-12 w-full rounded-2xl border border-white/45 bg-white/75 px-4 text-base text-[#261409] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none transition placeholder:text-[#9b8069] focus:border-nyy-500 focus:bg-white focus:ring-4 focus:ring-nyy-500/15 dark:border-white/12 dark:bg-white/[0.07] dark:text-white dark:placeholder:text-white/35 dark:focus:bg-white/[0.1] sm:text-[15px]";
const primaryBtnCls = "btn-primary h-12 w-full rounded-2xl text-[15px] disabled:opacity-45";
const subtleBtnCls = "type-action inline-flex min-h-[44px] items-center justify-center rounded-2xl px-4 text-[#8a6245] transition hover:bg-black/5 hover:text-[#43230f] dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white";

type AuthViewportStyle = CSSProperties & {
  "--auth-visual-height": string;
  "--auth-visual-offset-top": string;
  "--auth-keyboard-inset": string;
  "--auth-keyboard-spacer": string;
};

interface AuthViewportState {
  style: AuthViewportStyle;
  keyboardActive: boolean;
}

const defaultAuthViewportStyle: AuthViewportStyle = {
  "--auth-visual-height": "100dvh",
  "--auth-visual-offset-top": "0px",
  "--auth-keyboard-inset": "0px",
  "--auth-keyboard-spacer": "0px",
};

const keyboardInputTypes = new Set(["email", "number", "password", "search", "tel", "text", "url"]);
const keyboardActiveThreshold = 80;
const focusedFieldTopGap = 16;
const focusedFieldBottomGap = 180;

function getCurrentViewportHeight(): number {
  const viewport = window.visualViewport;
  return Math.max(
    window.innerHeight || 0,
    document.documentElement.clientHeight || 0,
    (viewport?.height ?? 0) + (viewport?.offsetTop ?? 0),
  );
}

function createAuthViewportState(baselineHeight: number): AuthViewportState {
  const viewport = window.visualViewport;
  const layoutHeight = Math.max(baselineHeight, getCurrentViewportHeight());
  const visualHeight = viewport?.height ?? layoutHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  const keyboardInset = Math.max(0, layoutHeight - visualHeight - offsetTop);
  const keyboardActive = keyboardInset > keyboardActiveThreshold;

  return {
    keyboardActive,
    style: {
      "--auth-visual-height": `${visualHeight}px`,
      "--auth-visual-offset-top": `${offsetTop}px`,
      "--auth-keyboard-inset": `${keyboardInset}px`,
      "--auth-keyboard-spacer": keyboardActive ? `${keyboardInset + focusedFieldBottomGap}px` : "0px",
    },
  };
}

function useAuthViewportState(open: boolean): AuthViewportState {
  const [viewportState, setViewportState] = useState<AuthViewportState>({
    style: defaultAuthViewportStyle,
    keyboardActive: false,
  });
  const baselineHeightRef = useRef(0);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    let frame = 0;
    const viewport = window.visualViewport;
    baselineHeightRef.current = Math.max(getCurrentViewportHeight(), viewport?.height ?? 0);
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        const keyboardInputFocused = isKeyboardInput(activeElement);
        const nextHeight = getCurrentViewportHeight();
        if (!keyboardInputFocused) baselineHeightRef.current = Math.max(baselineHeightRef.current, nextHeight);
        setViewportState(createAuthViewportState(baselineHeightRef.current));
      });
    };

    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);

  return open ? viewportState : { style: defaultAuthViewportStyle, keyboardActive: false };
}

function isKeyboardInput(target: EventTarget | null): target is HTMLElement {
  if (typeof window === "undefined") return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return keyboardInputTypes.has(target.type);
}

function scrollInputIntoDialogView(target: HTMLElement): void {
  const dialog = target.closest('[role="dialog"]') as HTMLElement | null;
  if (!dialog) {
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    return;
  }

  const viewport = window.visualViewport;
  const dialogRect = dialog.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const header = dialog.querySelector("[data-auth-header]") as HTMLElement | null;
  const headerRect = header?.getBoundingClientRect();
  const stickyHeaderHeight = headerRect && getComputedStyle(header!).position === "sticky" ? headerRect.height : 0;
  const visualTop = viewport?.offsetTop ?? 0;
  const visualBottom = visualTop + (viewport?.height ?? window.innerHeight);
  const safeTop = dialogRect.top + stickyHeaderHeight + focusedFieldTopGap;
  const safeBottom = Math.min(dialogRect.bottom, visualBottom) - focusedFieldBottomGap;
  const safeHeight = safeBottom - safeTop;

  let nextScrollTop = dialog.scrollTop;
  if (safeHeight <= targetRect.height) {
    if (targetRect.top < safeTop || targetRect.bottom > safeBottom) {
      nextScrollTop = dialog.scrollTop + targetRect.top - safeTop;
    }
  } else if (targetRect.bottom > safeBottom) {
    nextScrollTop = dialog.scrollTop + targetRect.bottom - safeBottom;
  } else if (targetRect.top < safeTop) {
    nextScrollTop = dialog.scrollTop + targetRect.top - safeTop;
  } else {
    return;
  }

  const maxScrollTop = Math.max(0, dialog.scrollHeight - dialog.clientHeight);

  dialog.scrollTo({
    top: Math.max(0, Math.min(maxScrollTop, nextScrollTop)),
    behavior: "auto",
  });
}

function getPasswordStrength(pw: string): { level: number; label: string; color: string } {
  if (!pw) return { level: 0, label: "", color: "bg-transparent" };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  if (score <= 1) return { level: 1, label: "偏弱", color: "bg-red-400" };
  if (score <= 3) return { level: 2, label: "可用", color: "bg-amber-400" };
  return { level: 3, label: "稳妥", color: "bg-emerald-400" };
}

function errorStatus(err: unknown): number | undefined {
  return typeof err === "object" && err && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

function emailLooksValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function StepMeter({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" aria-label="流程进度">
      {steps.map((step, index) => {
        const active = index === current;
        const done = index < current;
        return (
          <div
            key={step}
            className={`rounded-2xl border px-2 py-2 transition sm:px-3 ${
              active
                ? "border-nyy-500/70 bg-nyy-500/12 text-[#2a1810] shadow-[0_0_28px_rgba(255,138,61,0.18)] dark:text-white"
                : done
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200"
                  : "border-black/8 bg-white/45 text-[#8b7563] dark:border-white/10 dark:bg-white/[0.04] dark:text-white/45"
            }`}
          >
            <span className="type-caption flex items-center justify-center gap-1.5 whitespace-nowrap sm:justify-start sm:gap-2">
              <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${done ? "bg-emerald-500 text-white" : active ? "bg-nyy-500 text-white" : "bg-black/10 dark:bg-white/10"}`}>
                {done ? <Check className="h-3 w-3" /> : index + 1}
              </span>
              {step}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AuthField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block space-y-2">
      <span className="type-label text-[#6f5948] dark:text-white/62">{label}</span>
      {children}
      {hint && <span className="type-caption block text-[#9b8069] dark:text-white/38">{hint}</span>}
    </label>
  );
}

function InlineNotice({ type, children }: { type: "error" | "success" | "info"; children: React.ReactNode }) {
  const cls = {
    error: "border-red-400/30 bg-red-500/10 text-red-700 dark:text-red-200",
    success: "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
    info: "border-nyy-500/25 bg-nyy-500/10 text-[#7b4b29] dark:text-orange-100",
  }[type];
  return (
    <div role={type === "error" ? "alert" : "status"} className={`type-body-sm rounded-2xl border px-4 py-3 ${cls}`}>
      {children}
    </div>
  );
}

function PasswordStrength({ password }: { password: string }) {
  const strength = getPasswordStrength(password);
  if (!password) return null;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/8 dark:bg-white/10">
        <div className={`h-full rounded-full transition-all ${strength.color}`} style={{ width: `${(strength.level / 3) * 100}%` }} />
      </div>
      <span className="type-caption min-w-8 text-right text-[#8b7563] dark:text-white/45">{strength.label}</span>
    </div>
  );
}

function SecurityPanel({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <div className="rounded-3xl border border-nyy-500/20 bg-gradient-to-br from-nyy-500/10 to-white/40 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:from-nyy-500/12 dark:to-white/[0.04]">
      <div className="mb-3 flex items-center gap-2 text-[#7b4b29] dark:text-orange-100">
        <ShieldCheck className="h-4 w-4" />
        <p className="type-caption font-medium">{caption}</p>
      </div>
      {children}
    </div>
  );
}

function SidePanel() {
  const benefits = [
    { icon: <Mail className="h-4 w-4" />, title: "1 GB 账号配额", desc: "登录后分享和收件都能管理" },
    { icon: <ShieldCheck className="h-4 w-4" />, title: "可撤销、可追踪", desc: "链接过期、撤销和访问限制更清楚" },
    { icon: <KeyRound className="h-4 w-4" />, title: "30 天保持登录", desc: "安全 refresh cookie，不写本地 token" },
  ];

  return (
    <aside className="relative hidden min-h-[620px] w-[20rem] shrink-0 overflow-hidden border-r border-white/12 bg-[#13041f] p-8 text-white lg:block">
      <div className="absolute -left-24 top-10 h-52 w-52 rounded-full bg-nyy-500/25 blur-3xl" />
      <div className="absolute bottom-0 right-0 h-64 w-64 rounded-full bg-[#00D4FF]/10 blur-3xl" />
      <div className="relative flex h-full flex-col">
        <BrandLogo className="h-auto w-36" priority />
        <div className="mt-10">
          <p className="retro-kicker text-orange-200/55">账号中心</p>
          <h3 className="mt-3 text-2xl font-semibold leading-tight tracking-tight">把文件交给别人之前，先把控制权拿回来。</h3>
          <p className="type-body-sm mt-4 text-white/58">登录后，分享链接、收件入口和配额状态会集中到你的工作台。</p>
        </div>
        <div className="mt-10 space-y-3">
          {benefits.map((item) => (
            <div key={item.title} className="rounded-3xl border border-white/10 bg-white/[0.055] p-4 backdrop-blur-xl">
              <div className="flex gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-nyy-500/18 text-orange-100 ring-1 ring-nyy-500/25">
                  {item.icon}
                </span>
                <span>
                  <span className="type-body-sm block font-semibold text-white/92">{item.title}</span>
                  <span className="type-caption mt-1 block text-white/45">{item.desc}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-auto rounded-3xl border border-orange-200/10 bg-gradient-to-br from-orange-400/16 to-transparent p-4">
          <p className="type-caption text-orange-100/60">nyy.app · 想传文件？拿呀呀</p>
        </div>
      </div>
    </aside>
  );
}

function MobileBrandStrip({ compact }: { compact: boolean }) {
  return (
    <div className={`border-b border-black/8 bg-gradient-to-br from-nyy-500/12 via-white/55 to-[#00D4FF]/8 px-5 py-4 dark:border-white/10 dark:from-nyy-500/14 dark:via-white/[0.04] dark:to-[#00D4FF]/8 lg:hidden ${compact ? "hidden" : ""}`} data-auth-mobile-brand>
      <div className="flex items-center gap-4">
        <BrandLogo className="h-auto w-24" priority />
        <div>
          <p className="type-body-sm font-semibold text-[#2a1810] dark:text-white">登录后管理分享与收件</p>
          <p className="type-caption mt-0.5 text-[#7a6855] dark:text-white/45">1 GB 配额 · 30 天保持登录 · 安全验证码</p>
        </div>
      </div>
    </div>
  );
}

export function AuthModal({ open, onClose, onLoginSuccess }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginNeedsCaptcha, setLoginNeedsCaptcha] = useState(false);
  const [loginCaptchaToken, setLoginCaptchaToken] = useState<string | null>(null);

  const [regStep, setRegStep] = useState<RegisterStep>("email");
  const [regEmail, setRegEmail] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regCaptchaToken, setRegCaptchaToken] = useState<string | null>(null);
  const [regCaptchaResetKey, setRegCaptchaResetKey] = useState(0);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const [forgotStep, setForgotStep] = useState<ForgotStep>("email");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotCaptchaToken, setForgotCaptchaToken] = useState<string | null>(null);
  const [forgotCaptchaResetKey, setForgotCaptchaResetKey] = useState(0);
  const [forgotCountdown, setForgotCountdown] = useState(0);

  const registerStepIndex = regStep === "email" ? 0 : regStep === "password" ? 1 : 2;
  const forgotStepIndex = forgotStep === "email" ? 0 : forgotStep === "password" ? 1 : 2;
  const activePassword = tab === "register" ? regPassword : forgotPassword;
  const authViewportState = useAuthViewportState(open);
  const focusScrollTokenRef = useRef(0);
  const keyboardActive = authViewportState.keyboardActive;

  const title = useMemo(() => {
    if (tab === "login") return "登录拿呀呀";
    if (tab === "forgot") return "重置密码";
    return "注册拿呀呀";
  }, [tab]);
  const visibleTitle = keyboardActive
    ? tab === "login" ? "登录" : tab === "forgot" ? "重置" : "注册"
    : title;

  const resetState = useCallback(() => {
    setError("");
    setLoading(false);
    setShowPassword(false);
    setSuccessMsg("");
    setLoginNeedsCaptcha(false);
    setLoginCaptchaToken(null);
    setRegStep("email");
    setRegCode("");
    setRegPassword("");
    setRegCaptchaToken(null);
    setRegCaptchaResetKey(0);
    setAgreedTerms(false);
    setCountdown(0);
    setForgotStep("email");
    setForgotCode("");
    setForgotPassword("");
    setForgotCaptchaToken(null);
    setForgotCaptchaResetKey(0);
    setForgotCountdown(0);
  }, []);

  useEffect(() => {
    if (!open) resetState();
  }, [open, resetState]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (forgotCountdown <= 0) return;
    const timer = window.setTimeout(() => setForgotCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [forgotCountdown]);

  function switchTab(next: Tab) {
    setTab(next);
    resetState();
  }

  const handleDialogFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    if (!isKeyboardInput(event.target)) return;

    const target = event.target;
    const scrollToken = focusScrollTokenRef.current + 1;
    focusScrollTokenRef.current = scrollToken;

    const scrollFocusedInput = () => {
      if (focusScrollTokenRef.current !== scrollToken) return;
      scrollInputIntoDialogView(target);
    };

    const viewport = window.visualViewport;
    if (!viewport) {
      window.requestAnimationFrame(scrollFocusedInput);
      return;
    }

    const handleViewportChange = () => window.requestAnimationFrame(scrollFocusedInput);
    const timeoutIds = [0, 120, 300, 600, 900].map((delay) => window.setTimeout(scrollFocusedInput, delay));

    viewport.addEventListener("resize", handleViewportChange);
    viewport.addEventListener("scroll", handleViewportChange);
    window.setTimeout(() => {
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      viewport.removeEventListener("resize", handleViewportChange);
      viewport.removeEventListener("scroll", handleViewportChange);
    }, 1100);
  }, []);

  const handleDialogInput = useCallback((event: React.FormEvent<HTMLElement>) => {
    if (!isKeyboardInput(event.target)) return;

    const target = event.target;
    scrollInputIntoDialogView(target);
    window.requestAnimationFrame(() => scrollInputIntoDialogView(target));
    window.setTimeout(() => scrollInputIntoDialogView(target), 120);
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(loginEmail, loginPassword, loginCaptchaToken || undefined);
      const user = await getMe();
      onLoginSuccess(user);
      onClose();
    } catch (err: unknown) {
      if (errorStatus(err) === 428) {
        setLoginNeedsCaptcha(true);
        setError("登录失败次数过多，请先完成安全验证");
      } else {
        setError(getErrorMessage(err, "登录失败"));
      }
    } finally {
      setLoading(false);
    }
  }

  const handleRegSendCode = useCallback(async (captchaToken: string) => {
    setError("");
    setLoading(true);
    try {
      await sendCode(regEmail, captchaToken, "register");
      setRegStep("password");
      setCountdown(60);
      setSuccessMsg(`验证码已发送至 ${regEmail}`);
    } catch (err: unknown) {
      setRegCaptchaToken(null);
      setRegCaptchaResetKey((value) => value + 1);
      setError(getErrorMessage(err, "发送失败"));
    } finally {
      setLoading(false);
    }
  }, [regEmail]);

  const handleRegCaptchaVerified = useCallback((token: string) => {
    setRegCaptchaToken(token);
    void handleRegSendCode(token);
  }, [handleRegSendCode]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!agreedTerms) {
      setError("请先同意服务条款和隐私政策");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await register(regEmail, regPassword, regCode);
      setRegStep("complete");
      setSuccessMsg("注册成功，正在进入你的工作台...");
      await login(regEmail, regPassword);
      const user = await getMe();
      onLoginSuccess(user);
      onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "注册失败"));
    } finally {
      setLoading(false);
    }
  }

  const handleForgotSendCode = useCallback(async (captchaToken: string) => {
    setError("");
    setLoading(true);
    try {
      await sendCode(forgotEmail, captchaToken, "reset_password");
      setForgotStep("password");
      setForgotCountdown(60);
      setSuccessMsg(`验证码已发送至 ${forgotEmail}`);
    } catch (err: unknown) {
      setForgotCaptchaToken(null);
      setForgotCaptchaResetKey((value) => value + 1);
      setError(getErrorMessage(err, "发送失败"));
    } finally {
      setLoading(false);
    }
  }, [forgotEmail]);

  const handleForgotCaptchaVerified = useCallback((token: string) => {
    setForgotCaptchaToken(token);
    void handleForgotSendCode(token);
  }, [handleForgotSendCode]);

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await resetPassword(forgotEmail, forgotCode, forgotPassword);
      setForgotStep("complete");
      setSuccessMsg("密码已重置，请使用新密码登录");
      window.setTimeout(() => switchTab("login"), 1400);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "重置失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      isDismissable
      style={authViewportState.style}
      data-keyboard-active={keyboardActive ? "true" : undefined}
      className="fixed inset-0 z-50 block overflow-y-auto bg-[#170a03]/46 px-0 py-0 backdrop-blur-md [touch-action:pan-y] [-webkit-overflow-scrolling:touch] sm:grid sm:place-items-center sm:px-4 sm:py-6"
    >
      <Modal className="h-[var(--auth-visual-height)] min-h-[var(--auth-visual-height)] w-full translate-y-[var(--auth-visual-offset-top)] outline-none sm:h-auto sm:min-h-0 sm:w-[min(960px,calc(100vw-2rem))] sm:max-w-[960px] sm:translate-y-0">
        <Dialog className="h-[var(--auth-visual-height)] max-h-[var(--auth-visual-height)] overflow-y-auto bg-[#fff8f1] text-[#2a1810] shadow-[0_24px_90px_rgba(36,16,4,0.35)] outline-none [overflow-anchor:none] [scroll-padding-bottom:calc(var(--auth-keyboard-inset)+env(safe-area-inset-bottom)+6rem)] [touch-action:pan-y] [-webkit-overflow-scrolling:touch] dark:bg-[#110817] dark:text-white sm:h-auto sm:max-h-[min(820px,calc(100dvh-3rem))] sm:min-h-0 sm:overflow-hidden sm:rounded-[2rem] sm:border sm:border-white/18" aria-label={title}>
          <div className="flex min-h-[var(--auth-visual-height)] flex-col [overflow-anchor:none] sm:max-h-[min(820px,calc(100dvh-3rem))] sm:min-h-0 lg:flex-row" onFocusCapture={handleDialogFocus} onInputCapture={handleDialogInput}>
            <SidePanel />
            <div className="flex min-w-0 flex-1 flex-col">
              <MobileBrandStrip compact={keyboardActive} />
              <header className={`sticky top-0 z-20 flex shrink-0 justify-between gap-4 border-b border-black/8 bg-[#fff8f1]/95 px-5 backdrop-blur-md dark:border-white/10 dark:bg-[#110817]/95 sm:static sm:bg-transparent sm:px-8 sm:py-6 sm:backdrop-blur-0 ${keyboardActive ? "items-center py-2" : "items-start py-4"}`} data-auth-header>
                <div>
                  <p className={`retro-kicker ${keyboardActive ? "hidden" : ""}`}>安全入口</p>
                  <Heading slot="title" className={`font-semibold tracking-tight sm:text-3xl ${keyboardActive ? "text-lg" : "mt-1 text-2xl"}`}>
                    {visibleTitle}
                  </Heading>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="关闭"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-black/10 bg-white/60 text-[#6f5948] transition hover:bg-white hover:text-[#2a1810] dark:border-white/12 dark:bg-white/[0.06] dark:text-white/62 dark:hover:bg-white/12 dark:hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </header>

              <div className={`flex-none overflow-visible px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:px-8 sm:py-7 sm:pb-7 sm:[-webkit-overflow-scrolling:touch] ${keyboardActive ? "py-3" : "py-5"}`} data-auth-content>
                {tab !== "forgot" ? (
                  <div className={`grid grid-cols-2 rounded-3xl border border-black/8 bg-white/52 p-1 dark:border-white/10 dark:bg-white/[0.045] sm:mb-6 ${keyboardActive ? "mb-3" : "mb-6"}`}>
                    <button type="button" onClick={() => switchTab("login")} className={`${keyboardActive ? "h-11" : "h-12"} rounded-[1.25rem] type-action transition ${tab === "login" ? "bg-[#2a1810] text-white shadow-lg dark:bg-white dark:text-[#160b1d]" : "text-[#7a6855] hover:bg-white/60 dark:text-white/45 dark:hover:bg-white/8"}`}>登录</button>
                    <button type="button" onClick={() => switchTab("register")} className={`${keyboardActive ? "h-11" : "h-12"} rounded-[1.25rem] type-action transition ${tab === "register" ? "bg-gradient-to-br from-nyy-500 to-[#e0652a] text-white shadow-[0_12px_32px_rgba(255,138,61,0.28)]" : "text-[#7a6855] hover:bg-white/60 dark:text-white/45 dark:hover:bg-white/8"}`}>注册</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => switchTab("login")} className="mb-5 inline-flex min-h-[44px] items-center gap-2 rounded-2xl px-2 text-[#7a6855] transition hover:text-[#2a1810] dark:text-white/55 dark:hover:text-white">
                    <ArrowLeft className="h-4 w-4" /> 返回登录
                  </button>
                )}

                <div className="space-y-4">
                  {error && <InlineNotice type="error">{error}</InlineNotice>}
                  {successMsg && <InlineNotice type="success">{successMsg}</InlineNotice>}

                  {tab === "login" && (
                    <form onSubmit={handleLogin} className="space-y-5">
                      <div className="rounded-[1.75rem] border border-black/8 bg-white/58 p-4 dark:border-white/10 dark:bg-white/[0.045] sm:p-5">
                        <div className="space-y-4">
                          <AuthField label="邮箱">
                            <input className={inputCls} type="email" autoComplete="email" placeholder="you@example.com" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required />
                          </AuthField>
                          <AuthField label="密码">
                            <div className="relative">
                              <input className={`${inputCls} pr-12`} type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="输入密码" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required />
                              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl text-[#8b7563] transition hover:bg-black/5 dark:text-white/45 dark:hover:bg-white/10">
                                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                              </button>
                            </div>
                          </AuthField>
                        </div>
                      </div>

                      {loginNeedsCaptcha && !loginCaptchaToken && (
                        <SecurityPanel caption="登录保护已触发，请完成安全验证后继续">
                          <CaptchaChallenge purpose="login" onVerified={(token) => { setLoginCaptchaToken(token); setError(""); }} />
                        </SecurityPanel>
                      )}

                      <button type="submit" disabled={loading || (loginNeedsCaptcha && !loginCaptchaToken)} className={primaryBtnCls}>
                        {loading ? "登录中..." : loginNeedsCaptcha && !loginCaptchaToken ? "完成验证后登录" : "登录"}
                      </button>
                      <button type="button" onClick={() => switchTab("forgot")} className={`${subtleBtnCls} w-full`}>忘记密码？</button>
                    </form>
                  )}

                  {tab === "register" && (
                    <div className="space-y-5">
                      <StepMeter steps={["验证邮箱", "设置密码", "完成注册"]} current={registerStepIndex} />

                      {regStep === "email" && (
                        <div className="space-y-5 rounded-[1.75rem] border border-black/8 bg-white/58 p-4 dark:border-white/10 dark:bg-white/[0.045] sm:p-5">
                          <AuthField label="邮箱" hint="邮箱格式正确后，完成安全验证即可自动发送 6 位验证码。">
                            <input className={inputCls} type="email" autoComplete="email" placeholder="you@example.com" value={regEmail} onChange={(e) => { setRegEmail(e.target.value); setRegCaptchaToken(null); setRegCaptchaResetKey((value) => value + 1); }} required />
                          </AuthField>
                          {emailLooksValid(regEmail) ? (
                            <SecurityPanel caption={regCaptchaToken ? "验证通过，正在发送验证码" : "完成验证后发送邮箱验证码"}>
                              <CaptchaChallenge key={`register-${regEmail}-${regCaptchaResetKey}`} purpose="email_send" onVerified={handleRegCaptchaVerified} />
                            </SecurityPanel>
                          ) : (
                            <InlineNotice type="info">先输入有效邮箱，安全验证会在这里出现。</InlineNotice>
                          )}
                        </div>
                      )}

                      {regStep === "password" && (
                        <form onSubmit={handleRegister} className="space-y-5">
                          <div className="rounded-[1.75rem] border border-black/8 bg-white/58 p-4 dark:border-white/10 dark:bg-white/[0.045] sm:p-5">
                            <p className="type-body-sm mb-4 text-[#6f5948] dark:text-white/58">验证码已发送至 <strong className="text-[#2a1810] dark:text-white">{regEmail}</strong></p>
                            <div className="space-y-4">
                              <AuthField label="验证码" hint="支持直接粘贴邮件中的 6 位数字。">
                                <EmailCodeInput value={regCode} onChange={setRegCode} />
                              </AuthField>
                              <AuthField label="设置密码" hint="最少 8 位；不强制复杂组合，但会拦截常见弱密码。">
                                <div className="relative">
                                  <input className={`${inputCls} pr-12`} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="至少 8 位" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} required minLength={8} />
                                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl text-[#8b7563] transition hover:bg-black/5 dark:text-white/45 dark:hover:bg-white/10">
                                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                  </button>
                                </div>
                              </AuthField>
                              <PasswordStrength password={regPassword} />
                              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-black/8 bg-white/42 p-3 dark:border-white/10 dark:bg-white/[0.035]">
                                <input type="checkbox" checked={agreedTerms} onChange={(e) => setAgreedTerms(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-nyy-600 focus:ring-nyy-500" />
                                <span className="type-caption text-[#6f5948] dark:text-white/55">我已阅读并同意 <a href="/terms" target="_blank" className="font-medium text-nyy-600 hover:underline">服务条款</a> 和 <a href="/privacy" target="_blank" className="font-medium text-nyy-600 hover:underline">隐私政策</a></span>
                              </label>
                            </div>
                          </div>
                          <button type="submit" disabled={loading || regCode.length < 6 || regPassword.length < 8 || !agreedTerms} className={primaryBtnCls}>{loading ? "注册中..." : "注册并进入"}</button>
                          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                            <button type="button" onClick={() => { setRegStep("email"); setRegCaptchaToken(null); setRegCode(""); setSuccessMsg(""); }} className={subtleBtnCls}>更换邮箱</button>
                            <button type="button" disabled={countdown > 0} onClick={() => { setRegStep("email"); setRegCaptchaToken(null); setSuccessMsg(""); }} className={subtleBtnCls}>{countdown > 0 ? `${countdown}s 后可重新发送` : "重新验证并发送"}</button>
                          </div>
                        </form>
                      )}

                      {regStep === "complete" && (
                        <div className="rounded-[1.75rem] border border-emerald-400/25 bg-emerald-500/10 p-6 text-center">
                          <div className="mx-auto grid h-14 w-14 place-items-center rounded-3xl bg-emerald-500 text-white"><Check className="h-7 w-7" /></div>
                          <p className="type-section mt-4">注册完成</p>
                          <p className="type-body-sm mt-2 text-[#6f5948] dark:text-white/55">正在为你进入拿呀呀。</p>
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "forgot" && (
                    <div className="space-y-5">
                      <StepMeter steps={["验证邮箱", "设置新密码", "完成"]} current={forgotStepIndex} />

                      {forgotStep === "email" && (
                        <div className="space-y-5 rounded-[1.75rem] border border-black/8 bg-white/58 p-4 dark:border-white/10 dark:bg-white/[0.045] sm:p-5">
                          <AuthField label="注册邮箱" hint="邮箱格式正确后，完成安全验证即可发送重置验证码。">
                            <input className={inputCls} type="email" autoComplete="email" placeholder="you@example.com" value={forgotEmail} onChange={(e) => { setForgotEmail(e.target.value); setForgotCaptchaToken(null); setForgotCaptchaResetKey((value) => value + 1); }} required />
                          </AuthField>
                          {emailLooksValid(forgotEmail) ? (
                            <SecurityPanel caption={forgotCaptchaToken ? "验证通过，正在发送验证码" : "完成验证后发送重置验证码"}>
                              <CaptchaChallenge key={`forgot-${forgotEmail}-${forgotCaptchaResetKey}`} purpose="email_send" onVerified={handleForgotCaptchaVerified} />
                            </SecurityPanel>
                          ) : (
                            <InlineNotice type="info">先输入有效邮箱，安全验证会在这里出现。</InlineNotice>
                          )}
                        </div>
                      )}

                      {forgotStep === "password" && (
                        <form onSubmit={handleResetPassword} className="space-y-5">
                          <div className="rounded-[1.75rem] border border-black/8 bg-white/58 p-4 dark:border-white/10 dark:bg-white/[0.045] sm:p-5">
                            <p className="type-body-sm mb-4 text-[#6f5948] dark:text-white/58">验证码已发送至 <strong className="text-[#2a1810] dark:text-white">{forgotEmail}</strong></p>
                            <div className="space-y-4">
                              <AuthField label="验证码">
                                <EmailCodeInput value={forgotCode} onChange={setForgotCode} />
                              </AuthField>
                              <AuthField label="新密码">
                                <div className="relative">
                                  <input className={`${inputCls} pr-12`} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="至少 8 位" value={forgotPassword} onChange={(e) => setForgotPassword(e.target.value)} required minLength={8} />
                                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"} className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl text-[#8b7563] transition hover:bg-black/5 dark:text-white/45 dark:hover:bg-white/10">
                                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                  </button>
                                </div>
                              </AuthField>
                              <PasswordStrength password={forgotPassword} />
                            </div>
                          </div>
                          <button type="submit" disabled={loading || forgotCode.length < 6 || forgotPassword.length < 8} className={primaryBtnCls}>{loading ? "重置中..." : "重置密码"}</button>
                          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                            <button type="button" onClick={() => { setForgotStep("email"); setForgotCaptchaToken(null); setForgotCode(""); setSuccessMsg(""); }} className={subtleBtnCls}>更换邮箱</button>
                            <button type="button" disabled={forgotCountdown > 0} onClick={() => { setForgotStep("email"); setForgotCaptchaToken(null); setSuccessMsg(""); }} className={subtleBtnCls}>{forgotCountdown > 0 ? `${forgotCountdown}s 后可重新发送` : "重新验证并发送"}</button>
                          </div>
                        </form>
                      )}

                      {forgotStep === "complete" && (
                        <div className="rounded-[1.75rem] border border-emerald-400/25 bg-emerald-500/10 p-6 text-center">
                          <div className="mx-auto grid h-14 w-14 place-items-center rounded-3xl bg-emerald-500 text-white"><Sparkles className="h-7 w-7" /></div>
                          <p className="type-section mt-4">密码已重置</p>
                          <p className="type-body-sm mt-2 text-[#6f5948] dark:text-white/55">即将回到登录页。</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <footer className={`shrink-0 border-t border-black/8 bg-white/32 px-5 py-3 dark:border-white/10 dark:bg-white/[0.035] sm:block sm:px-8 ${keyboardActive ? "hidden" : ""}`}>
                <p className="type-caption text-center text-[#8b7563] dark:text-white/38">验证码 10 分钟内有效。我们不会在浏览器本地存储登录 token。</p>
              </footer>
              <div aria-hidden="true" className="h-[var(--auth-keyboard-spacer)] shrink-0 sm:hidden" />
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
