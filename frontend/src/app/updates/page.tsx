import type { Metadata } from "next";
import { UpdatesClient } from "@/components/updates-client";

export const metadata: Metadata = {
  title: "最近更新",
  description: "查看拿呀²最近上线的新功能、问题修复和维护完成时间。",
  alternates: { canonical: "/updates" },
};

export default function UpdatesPage() {
  return <UpdatesClient />;
}
