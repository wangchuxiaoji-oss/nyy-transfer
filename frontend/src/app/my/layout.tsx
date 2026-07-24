import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `我的工作台 - ${BRAND_NAME}`,
  description: "管理分享链接、收件入口和收到的文件，查看上传额度。",
  robots: { index: false, follow: false },
};

export default function MyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
