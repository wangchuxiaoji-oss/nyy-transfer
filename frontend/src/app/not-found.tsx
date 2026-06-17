import Link from "next/link";
import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `页面未找到 - ${BRAND_NAME}`,
};

export default function NotFound() {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">
        <main className="flex min-h-dvh flex-col items-center justify-center bg-[#FFF4EB] px-6 text-center dark:bg-[#0A0418]">
          <p className="font-tech text-[10px] tracking-[0.3em] text-gray-400 dark:text-white/45">
            404
          </p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
            页面不存在或分享已过期
          </h1>
          <p className="mt-3 max-w-sm text-sm text-gray-500 dark:text-white/55">
            你访问的链接可能已经失效，或者地址输入有误。
          </p>
          <Link
            href="/"
            className="mt-8 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-to-br from-[#FF8A3D] to-[#e0652a] px-6 text-sm font-bold text-white shadow-[0_8px_24px_rgba(255,138,61,0.3)] transition-transform hover:scale-105"
          >
            回到{BRAND_NAME}首页
          </Link>
        </main>
      </body>
    </html>
  );
}
