import type { Metadata } from "next";
import "./preview.css";

export const metadata: Metadata = {
  title: "全站设计审阅 - 拿呀²",
  description: "拿呀²全站新版 UI 隔离预览中心",
  robots: { index: false, follow: false, nocache: true },
};

export default function DesignPreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
