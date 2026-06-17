import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `管理后台 - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
