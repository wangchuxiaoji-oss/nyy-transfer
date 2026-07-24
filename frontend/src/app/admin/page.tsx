"use client";

import { Suspense } from "react";
import { AdminShell } from "@/components/admin/admin-shell";

export default function AdminPage() {
  return (
    <Suspense fallback={<main className="nyy-product-shell admin-console-shell flex items-center justify-center retro-text">加载后台...</main>}>
      <AdminShell />
    </Suspense>
  );
}
