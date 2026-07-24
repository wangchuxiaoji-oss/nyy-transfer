"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { recordGrowthLanding } from "@/lib/growth";

const TRACKED_PATHS = new Set([
  "/",
  "/large-file-transfer",
  "/no-signup-file-sharing",
  "/receive-files",
  "/wechat-large-file",
  "/how-it-works",
  "/security",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
]);

export function GrowthTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!TRACKED_PATHS.has(pathname)) return;
    void recordGrowthLanding(new URL(window.location.href)).catch(() => {});
  }, [pathname]);

  return null;
}
