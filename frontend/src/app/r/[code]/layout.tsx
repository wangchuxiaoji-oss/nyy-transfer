import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `收文件 - ${BRAND_NAME}`,
  description: "对方通过此链接向你提交文件。",
  robots: { index: false, follow: false },
};

export default function ReceivingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
