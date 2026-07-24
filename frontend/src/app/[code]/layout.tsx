import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/copy";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ code: string }>;
  children: React.ReactNode;
};

async function fetchShareInfo(code: string) {
  if (code.includes(".")) return null;
  try {
    const res = await fetch(
      `http://127.0.0.1:8000/api/v1/shares/${encodeURIComponent(code)}`,
      { cache: "no-cache" }
    );
    if (res.ok) return await res.json();
    if (res.status === 404 || res.status === 410) return undefined; // 不存在或已过期
  } catch {}
  return null; // 网络错误，放行
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  if (code.includes(".")) return { title: BRAND_NAME, robots: { index: false, follow: false } };

  const data = await fetchShareInfo(code);
  const files = data?.has_password ? [] : data?.files || [];
  const fileName = files.length === 1 ? files[0].file_name || "" : files.slice(0, 3).map((f: { file_name?: string }) => f.file_name || "文件").join("、");
  const title = files.length === 1 ? fileName : files.length > 1 ? `${files.length} 个文件` : "";
  const description = title ? `${title} - 通过拿呀² 在线预览和下载` : "通过拿呀² 在线预览和下载文件";

  return {
    title: title ? `${title} - ${BRAND_NAME}` : BRAND_NAME,
    description,
    robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
    openGraph: { title: fileName || BRAND_NAME, description },
  };
}

export default async function ShareLayout({ children, params }: Props) {
  const { code } = await params;
  if (code.includes(".")) notFound();
  if (process.env.NODE_ENV === "production") {
    const data = await fetchShareInfo(code);
    if (data === undefined) notFound(); // API 明确返回 404/410
  }

  return <>{children}</>;
}
