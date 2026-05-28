"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

interface ToastInput {
  type?: ToastType;
  title: string;
  description?: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const iconByType = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertCircle,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    const id = crypto.randomUUID();
    const nextToast: ToastItem = {
      id,
      type: toast.type || "info",
      title: toast.title,
      description: toast.description,
    };
    setToasts((current) => [nextToast, ...current].slice(0, 4));
    window.setTimeout(() => dismiss(id), toast.duration ?? 4000);
  }, [dismiss]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="fixed right-4 top-[calc(env(safe-area-inset-top)+1rem)] z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3 sm:right-6"
      >
        {toasts.map((toast) => {
          const Icon = iconByType[toast.type];
          return (
            <div
              key={toast.id}
              className={cn(
                "flex items-start gap-3 rounded-2xl border bg-white dark:bg-card p-4 shadow-lg shadow-black/10 dark:shadow-black/30",
                toast.type === "success" && "border-green-200 dark:border-green-800/40",
                toast.type === "error" && "border-red-200 dark:border-red-800/40",
                toast.type === "warning" && "border-amber-200 dark:border-amber-800/40",
                toast.type === "info" && "border-orange-100 dark:border-orange-800/40"
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 h-5 w-5 flex-shrink-0",
                  toast.type === "success" && "text-green-600",
                  toast.type === "error" && "text-red-600",
                  toast.type === "warning" && "text-amber-600",
                  toast.type === "info" && "text-nyy-700"
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="type-label text-gray-900 dark:text-gray-100">{toast.title}</p>
                {toast.description && <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">{toast.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="关闭提示"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
