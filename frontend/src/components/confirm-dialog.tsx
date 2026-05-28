"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const focusFirst = () => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(focusFirst);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onCancel} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" className="relative w-full max-w-sm rounded-3xl bg-white dark:bg-card p-6 shadow-2xl">
        <button
          type="button"
          onClick={onCancel}
          aria-label="关闭确认弹窗"
          className="absolute right-3 top-3 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3 pr-10">
          <div className={cn("rounded-2xl p-3", danger ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400" : "bg-orange-50 dark:bg-orange-900/20 text-nyy-700 dark:text-nyy-400")}>
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h2 id="confirm-dialog-title" className="type-section text-gray-900 dark:text-gray-100">{title}</h2>
            <p className="type-body-sm mt-2 text-gray-600 dark:text-gray-400">{description}</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="type-action min-h-[44px] rounded-xl border border-gray-300 dark:border-gray-600 px-4 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5">
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              "type-action min-h-[44px] rounded-xl px-4 font-semibold text-white disabled:opacity-60",
              danger ? "bg-red-600 hover:bg-red-700" : "bg-action hover:bg-action-hover"
            )}
          >
            {loading ? "处理中..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
