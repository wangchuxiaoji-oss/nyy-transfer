import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `服务条款 - ${BRAND_NAME}`,
  robots: { index: false },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/" className="text-sm text-gray-500 dark:text-gray-400 hover:text-orange-500 transition-colors inline-flex min-h-[44px] items-center">
        ← 返回{BRAND_NAME}
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">服务条款</h1>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">最后更新：2026年6月</p>

      <section className="mt-8 space-y-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        <p>使用拿呀²即表示你同意以下条款。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">1. 服务说明</h2>
        <p>拿呀²提供文件分享和收件服务。文件通过浏览器直传，生成分享链接后对方即可访问和下载。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">2. 用户责任</h2>
        <p>你承诺不上传、分享任何违法或侵权内容。我们有权删除违规内容并封禁相关账号。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">3. 服务可用性</h2>
        <p>我们尽力保证服务稳定运行，但不承诺 100% 可用。分享链接有有效期限制，请自行备份重要文件。</p>

        <h2 className="mt-6 text-base font-semibold text-gray-800 dark:text-gray-100">4. 免责声明</h2>
        <p>拿呀²不对用户上传的内容负责。文件分享行为及后果由用户自行承担。</p>
      </section>
    </div>
  );
}
