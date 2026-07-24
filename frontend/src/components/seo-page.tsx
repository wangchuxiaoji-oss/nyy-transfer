import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, CheckCircle2, Mail } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { BRAND_NAME } from "@/lib/copy";
import type { SeoPageContent } from "@/lib/seo-pages";

const OG_IMAGE = "https://nyy.app/logo-home-preview.png";

export function createSeoMetadata(page: SeoPageContent): Metadata {
  const canonical = `https://nyy.app/${page.slug}`;
  return {
    title: `${page.title} - ${BRAND_NAME}`,
    description: page.description,
    alternates: { canonical },
    openGraph: {
      type: "article",
      siteName: BRAND_NAME,
      locale: "zh_CN",
      url: canonical,
      title: page.title,
      description: page.description,
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: page.title }],
    },
    twitter: { card: "summary_large_image", title: page.title, description: page.description, images: [OG_IMAGE] },
  };
}

export function SeoPage({ page }: { page: SeoPageContent }) {
  const canonical = `https://nyy.app/${page.slug}`;
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.title,
      headline: page.headline,
      description: page.description,
      url: canonical,
      inLanguage: "zh-CN",
      isPartOf: { "@type": "WebSite", name: BRAND_NAME, url: "https://nyy.app" },
      author: { "@type": "Person", name: "DEX" },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "首页", item: "https://nyy.app/" },
        { "@type": "ListItem", position: 2, name: page.title.split("：")[0], item: canonical },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    },
  ];
  const related = [
    ["/large-file-transfer", "大文件传输"], ["/no-signup-file-sharing", "免注册分享"], ["/receive-files", "在线收文件"],
    ["/wechat-large-file", "微信发大文件"], ["/how-it-works", "工作原理"], ["/security", "安全说明"], ["/about", "关于"], ["/contact", "联系"],
  ].filter(([href]) => href !== `/${page.slug}`).slice(0, 3);

  return (
    <main className="nyy-product-shell min-h-dvh">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      <div className="nyy-product-content">
        <header className="border-b border-black/8 bg-white/45 backdrop-blur-xl dark:border-white/10 dark:bg-black/10">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <BrandLogo href="/" className="h-auto w-28 sm:w-36" priority />
            <div className="flex items-center gap-1"><Link href="/" className="retro-nav-button"><ArrowLeft className="h-4 w-4" />首页工具</Link><ThemeToggle /></div>
          </div>
        </header>

        <div className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
          <nav aria-label="面包屑" className="flex items-center gap-2 type-caption retro-muted"><Link href="/" className="hover:text-orange-500">首页</Link><span>/</span><span>{page.title.split("：")[0]}</span></nav>
          <section className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-end">
            <div>
              <p className="retro-kicker">{page.eyebrow}</p>
              <h1 className="mt-4 max-w-4xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.035em] retro-text sm:text-6xl">{page.headline}</h1>
              <p className="mt-6 max-w-3xl text-base leading-8 retro-text sm:text-lg">{page.lead}</p>
            </div>
            <div className="rounded-3xl border border-orange-400/25 bg-orange-500/10 p-5 shadow-[0_18px_50px_rgba(255,138,61,0.12)]">
              <p className="retro-kicker text-orange-700 dark:text-orange-200">直接回答</p>
              <p className="mt-3 text-sm leading-7 retro-text">{page.directAnswer}</p>
            </div>
          </section>

          <div className="mt-14 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="retro-panel p-4">
                <p className="retro-kicker px-2">本文目录</p>
                <nav className="mt-3 grid gap-1" aria-label="本文目录">
                  {page.sections.map((section, index) => <a key={section.title} href={`#section-${index + 1}`} className="flex min-h-[42px] items-center gap-3 rounded-xl px-2 text-sm retro-text hover:bg-orange-500/10 hover:text-orange-600"><span className="font-mono text-[10px] text-orange-500">0{index + 1}</span>{section.title}</a>)}
                  <a href="#faq" className="flex min-h-[42px] items-center gap-3 rounded-xl px-2 text-sm retro-text hover:bg-orange-500/10 hover:text-orange-600"><span className="font-mono text-[10px] text-orange-500">05</span>常见问题</a>
                </nav>
              </div>
            </aside>

            <article className="min-w-0">
              {page.sections.map((section, index) => (
                <section key={section.title} id={`section-${index + 1}`} className="scroll-mt-8 border-t border-black/10 py-10 first:border-t-0 first:pt-0 dark:border-white/10">
                  <div className="grid gap-5 sm:grid-cols-[3.5rem_minmax(0,1fr)]">
                    <span className="font-mono text-sm font-bold text-orange-500">0{index + 1}</span>
                    <div><h2 className="retro-title text-2xl leading-tight">{section.title}</h2><div className="mt-5 space-y-5">{section.paragraphs.map((paragraph) => <p key={paragraph.slice(0, 30)} className="text-[15px] leading-8 retro-text">{paragraph}</p>)}</div></div>
                  </div>
                </section>
              ))}

              <section id="faq" className="scroll-mt-8 border-t border-black/10 pt-10 dark:border-white/10">
                <p className="retro-kicker">FAQ</p><h2 className="retro-title mt-2 text-2xl">常见问题</h2>
                <div className="mt-6 space-y-3">{page.faqs.map((faq, index) => <details key={faq.question} className="retro-panel px-5" open={index === 0}><summary className="flex min-h-[58px] cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold retro-text [&::-webkit-details-marker]:hidden">{faq.question}<span className="text-xl text-orange-500">+</span></summary><p className="border-t border-black/8 pb-5 pt-4 text-sm leading-7 retro-text dark:border-white/10">{faq.answer}</p></details>)}</div>
              </section>
            </article>
          </div>

          <section className="mt-16 rounded-[2rem] border border-orange-400/25 bg-[#17081d] p-7 text-white shadow-[0_24px_70px_rgba(70,24,7,0.2)] sm:p-10">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-200/60">Try the actual tool</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">说明读完，回到工具直接试一次。</h2><p className="mt-3 max-w-2xl text-sm leading-7 text-white/60">首页首屏保留完整上传与收件操作，当前额度和选项以页面实时显示为准。</p></div><Link href="/" className="btn-primary min-w-44">开始传文件 <ArrowRight className="h-4 w-4" /></Link></div>
          </section>

          <section className="mt-12"><p className="retro-kicker">继续了解</p><div className="mt-4 grid gap-3 sm:grid-cols-3">{related.map(([href, label]) => <Link key={href} href={href} className="retro-card group flex min-h-24 items-center justify-between gap-4 p-5"><span className="font-semibold retro-text">{label}</span><ArrowRight className="h-4 w-4 text-orange-500 transition-transform group-hover:translate-x-1" /></Link>)}</div></section>

          <footer className="mt-12 flex flex-col gap-4 border-t border-black/10 py-8 text-sm retro-muted dark:border-white/10 sm:flex-row sm:items-center sm:justify-between"><span><CheckCircle2 className="mr-1 inline h-4 w-4 text-orange-500" />内容按当前产品实现维护</span><a href="mailto:admin@nyy.app" className="inline-flex min-h-[44px] items-center gap-2 hover:text-orange-500"><Mail className="h-4 w-4" />admin@nyy.app</a></footer>
        </div>
      </div>
    </main>
  );
}
