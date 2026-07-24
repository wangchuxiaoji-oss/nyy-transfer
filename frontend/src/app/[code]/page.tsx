"use client";

import { useParams } from "next/navigation";

import { ShareViewer } from "@/components/share-viewer";
import { ViralShareCta } from "@/components/viral-share-cta";

export default function SharePage() {
  const params = useParams();
  const code = params.code as string;
  return <><ShareViewer code={code} /><ViralShareCta shareCode={code} /></>;
}
