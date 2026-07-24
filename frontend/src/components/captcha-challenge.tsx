"use client";

import { createElement, useState, useEffect, useCallback, useRef, type HTMLAttributes, type Ref } from "react";
import { getCaptchaChallenge, verifyCaptcha } from "@/lib/auth";

function AltchaWidget(props: HTMLAttributes<HTMLElement> & { challenge?: string; auto?: string; name?: string; ref?: Ref<HTMLElement> }) {
  return createElement("altcha-widget", props);
}

interface CaptchaChallengeProps {
  purpose: "email_send" | "login";
  onVerified: (captchaToken: string) => void;
  onError?: (error: string) => void;
  autoVerify?: boolean;
}

export function CaptchaChallenge({
  purpose,
  onVerified,
  onError,
  autoVerify = false,
}: CaptchaChallengeProps) {
  const [loading, setLoading] = useState(false);
  const [widgetReady, setWidgetReady] = useState(false);
  const [insecureContext, setInsecureContext] = useState(false);
  const [error, setError] = useState("");
  const widgetRef = useRef<HTMLElement | null>(null);
  const challengeRef = useRef<{ id: string; purpose: string } | null>(null);

  // 加载本地 ALTCHA Web Component
  useEffect(() => {
    let cancelled = false;
    if (!window.isSecureContext) {
      setInsecureContext(true);
      setError("人机验证需要 HTTPS，或使用 localhost 打开页面");
      return () => { cancelled = true; };
    }
    import("altcha")
      .then(() => {
        if (!cancelled) setWidgetReady(true);
      })
      .catch(() => {
        const msg = "验证码组件加载失败";
        setError(msg);
        onError?.(msg);
      });
    return () => { cancelled = true; };
  }, [onError]);

  const handleVerified = useCallback(
    async (payload: string) => {
      if (!challengeRef.current) return;
      setLoading(true);
      setError("");
      try {
        const result = await verifyCaptcha(
          challengeRef.current.id,
          challengeRef.current.purpose as "email_send" | "login",
          payload
        );
        onVerified(result.captcha_token);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "验证码校验失败";
        setError(msg);
        const widget = widgetRef.current as HTMLElement & {
          reset?: (newState?: string, err?: string | null) => void;
        } | null;
        widget?.reset?.("unverified", msg);
        onError?.(msg);
      } finally {
        setLoading(false);
      }
    },
    [onVerified, onError]
  );

  const handleStateChange = useCallback(
    (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail?.state === "verified" && detail?.payload) {
        handleVerified(detail.payload);
      }
    },
    [handleVerified]
  );

  // 获取 challenge 并配置 widget
  const fetchChallenge = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getCaptchaChallenge(purpose);
      challengeRef.current = { id: data.challenge_id, purpose };

      const widget = widgetRef.current as HTMLElement & {
        configure?: (opts: Record<string, unknown>) => void;
      } | null;
      if (!widget?.configure) {
        throw new Error("验证码组件尚未就绪");
      }
      await widget.configure({
        challenge: data.challenge,
        auto: autoVerify ? "onload" : "off",
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "获取验证码失败";
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [purpose, autoVerify, onError]);

  useEffect(() => {
    if (widgetReady) fetchChallenge();
  }, [fetchChallenge, widgetReady]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    widget.addEventListener("statechange", handleStateChange);
    return () => {
      widget.removeEventListener("statechange", handleStateChange);
    };
  }, [handleStateChange]);

  return (
    <div className="space-y-2">
      {!insecureContext && <AltchaWidget ref={widgetRef as React.Ref<HTMLElement>} />}
      {loading && (
        <p className="type-caption text-gray-500">加载验证...</p>
      )}
      {error && (
        <p className="type-caption text-red-500">{error}</p>
      )}
    </div>
  );
}
