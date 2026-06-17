import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `隐私政策 - ${BRAND_NAME}`,
  robots: { index: false },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-gray-800 dark:text-gray-200">
      <Link href="/" className="text-sm text-gray-500 dark:text-gray-400 hover:text-orange-500 transition-colors inline-flex min-h-[44px] items-center">
        ← 返回{BRAND_NAME}
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">隐私政策</h1>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">最后更新：2026年6月</p>

      <section className="mt-8 space-y-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        <p>拿呀²（nyy.app）重视用户隐私。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">1. 收集的信息</h2>
        <p>注册时收集邮箱地址。上传的文件暂存于服务器以生成分享链接，过期后自动删除。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">2. 信息使用</h2>
        <p>邮箱用于账号登录。文件仅用于生成分享链接，不扫描、不转售。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">3. 数据存储与删除</h2>
        <p>文件在分享过期后自动清除。你可随时删除自己的文件和分享。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">4. 联系我们</h2>
        <p>隐私相关问题请联系：407389487@qq.com。</p>
      </section>
    </div>
  );
}
