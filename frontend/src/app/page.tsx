import dynamic from "next/dynamic";
import { HomeClient } from "@/components/home-client";
import { HOME_FAQS } from "@/lib/home-faqs";

/**
 * 首页：Server Component
 *
 * 渲染顺序：
 * 1. HomeHero — 各端紧凑展示的品牌 Hero
 * 2. HomeClient — Header(fixed) + 上传面板 + Debug + 游客分享 + Auth 弹窗
 * 3. HomeStory — 营销内容（三步流程 · 统计 · 场景 · 安全 · 差异化 · FAQ · CTA · 页脚）
 *
 * 各端都优先让上传面板进入首屏。Header 是 fixed 定位，不影响文档流。
 */
const HomeHero = dynamic(
  () => import("@/components/home-story").then((m) => m.HomeHero),
  { ssr: true }
);

const HomeStory = dynamic(
  () => import("@/components/home-story").then((m) => m.HomeStory),
  { ssr: true }
);

export default function Home() {
  return (
    <main className="nyy-product-shell flex flex-col items-center px-4 pt-0 pb-16" aria-label="拿呀²首页" data-ui-revision="20260722.4">
      {/* 1. 紧凑 Hero — 各端都让操作区进入首屏 */}
      <HomeHero />

      {/* 2. 交互区域 — Header(fixed) + 上传面板 + Debug + 游客分享 + Auth 弹窗 */}
      <HomeClient />

      {/* 3. 营销内容 — 三步流程 · 统计 · 场景 · 安全 · 差异化 · FAQ · CTA · 页脚 */}
      <HomeStory />

      {/* FAQ 结构化数据（仅此处输出，避免重复） */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: HOME_FAQS.map((item) => ({
              "@type": "Question",
              name: item.question,
              acceptedAnswer: { "@type": "Answer", text: item.answer },
            })),
          }),
        }}
      />
    </main>
  );
}
