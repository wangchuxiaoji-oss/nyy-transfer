"use client";

import { useParams } from "next/navigation";

import { ShareViewer } from "@/components/share-viewer";

export default function AdminSharePreviewPage() {
  const params = useParams();
  return <ShareViewer code={params.code as string} mode="admin" />;
}
