"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyLinkButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {
  onCopy: () => Promise<void> | void;
  label?: string;
  copiedLabel?: string;
  copiedDuration?: number;
  iconOnly?: boolean;
  iconClassName?: string;
}

export function CopyLinkButton({
  onCopy,
  label = "复制链接",
  copiedLabel = "已复制",
  copiedDuration = 1400,
  iconOnly = false,
  iconClassName = "h-4 w-4",
  className,
  disabled,
  title,
  "aria-label": ariaLabel,
  ...props
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const Icon = copied ? Check : Copy;
  const accessibleLabel = ariaLabel || (copied ? copiedLabel : label);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), copiedDuration);
  };

  return (
    <button
      type="button"
      {...props}
      disabled={disabled}
      onClick={handleCopy}
      title={title || accessibleLabel}
      aria-label={accessibleLabel}
      className={cn(
        className,
        copied && "!border-emerald-400/80 !bg-emerald-50 !text-emerald-700 !shadow-[0_0_0_3px_rgba(16,185,129,0.12),0_10px_24px_rgba(16,185,129,0.16)] dark:!border-emerald-300/60 dark:!bg-emerald-400/10 dark:!text-emerald-200 dark:!shadow-[0_0_24px_rgba(52,211,153,0.16)]"
      )}
    >
      <Icon className={iconClassName} />
      {!iconOnly && (
        <span className="grid whitespace-nowrap text-center" aria-live="polite">
          <span className="invisible col-start-1 row-start-1" aria-hidden="true">{label}</span>
          <span className="invisible col-start-1 row-start-1" aria-hidden="true">{copiedLabel}</span>
          <span className="col-start-1 row-start-1">{copied ? copiedLabel : label}</span>
        </span>
      )}
    </button>
  );
}
