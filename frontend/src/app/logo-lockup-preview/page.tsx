import Image from "next/image";
import { BRAND_NAME } from "@/lib/copy";

const symbolSrc = "/logo-home-preview.png?v=20260608-upload-dfdzXE";
const wordmarkSrc = "/logo-main.webp?v=20260607-malt-logo";

const sizes = [96, 56, 32, 20];

function SymbolMark({ className = "h-24 w-auto" }: { className?: string }) {
  return <Image src={symbolSrc} alt={`${BRAND_NAME} 图形符号`} width={1459} height={1034} className={`object-contain ${className}`} />;
}

function Wordmark({ className = "h-20 w-auto" }: { className?: string }) {
  return <Image src={wordmarkSrc} alt={`${BRAND_NAME} 字标`} width={1904} height={1050} className={`object-contain ${className}`} />;
}

function PreviewCard({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <article className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/62 p-5 shadow-[0_22px_70px_rgba(111,58,16,0.13)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.055]">
      <div className="mb-4">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-[#d66a1d]">Lockup</p>
        <h2 className="mt-1 text-xl font-black tracking-tight">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[#704018] dark:text-[#f6c98d]">{note}</p>
      </div>
      <div className="grid min-h-64 place-items-center rounded-[1.5rem] border border-[#f4c37b]/50 bg-[#fff8ec]/70 p-6 dark:border-white/10 dark:bg-black/18">
        {children}
      </div>
    </article>
  );
}

export default function LogoLockupPreviewPage() {
  return (
    <main className="min-h-dvh overflow-hidden bg-[#fff7ec] px-4 py-10 text-[#3c1c07] dark:bg-[#110905] dark:text-[#fff4df]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(255,180,77,0.34),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,122,36,0.18),transparent_26%),linear-gradient(135deg,rgba(255,255,255,0.58),transparent_45%)] dark:bg-[radial-gradient(circle_at_18%_12%,rgba(255,142,61,0.18),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,210,121,0.12),transparent_26%)]" />
      <section className="relative mx-auto max-w-6xl">
        <div className="rounded-[2rem] border border-white/70 bg-white/58 p-5 shadow-[0_30px_90px_rgba(130,70,18,0.16)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.06] sm:p-8">
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.28em] text-[#d66a1d]">Nayy Lockup Lab</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-6xl">图形符号 + 字标组合</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#704018] dark:text-[#f6c98d]">
                用你上传的新图形符号和现有麦芽糖字标做组合预览。这里不改正式资源，只看比例、间距、横竖版和小尺寸识别。
              </p>
            </div>
            <div className="rounded-[1.5rem] border border-[#f4c37b]/60 bg-[#fffaf2]/80 p-5 dark:border-white/10 dark:bg-black/20">
              <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c1601c]">Source Assets</p>
              <div className="mt-4 flex items-center justify-center gap-5">
                <SymbolMark className="h-20 w-auto" />
                <div className="h-14 w-px bg-[#e6b060]/60" />
                <Wordmark className="h-16 w-auto" />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <PreviewCard title="推荐 01：横版 90% 图形" note="图形略小于字标，可带出“挎信封”的语义，但不抢走品牌名。">
            <div className="flex items-center gap-7">
              <SymbolMark className="h-24 w-auto -translate-y-0.5" />
              <Wordmark className="h-[6.6rem] w-auto" />
            </div>
          </PreviewCard>

          <PreviewCard title="方案 02：横版等高" note="图形和字标可视高度接近，品牌符号更强，但首页 Hero 里可能稍微抢眼。">
            <div className="flex items-center gap-8">
              <SymbolMark className="h-28 w-auto" />
              <Wordmark className="h-28 w-auto" />
            </div>
          </PreviewCard>

          <PreviewCard title="方案 03：竖版启动页" note="适合启动页、空状态、分享完成页；不建议用于顶部导航。">
            <div className="flex flex-col items-center gap-5">
              <SymbolMark className="h-32 w-auto" />
              <Wordmark className="h-24 w-auto" />
            </div>
          </PreviewCard>

          <PreviewCard title="方案 04：符号独立使用" note="适合 App icon、favicon、loading、按钮图标，只保留动作语义。">
            <div className="flex items-end gap-8">
              {sizes.map((size) => (
                <div key={size} className="flex flex-col items-center gap-2">
                  <Image src={symbolSrc} alt={`${BRAND_NAME} ${size}px 符号`} width={1459} height={1034} style={{ width: size, height: Math.round(size * 0.71) }} className="object-contain" />
                  <span className="text-[10px] font-bold text-[#a4682a] dark:text-[#d9a468]">{size}px</span>
                </div>
              ))}
            </div>
          </PreviewCard>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <PreviewCard title="深色横版验证" note="检查图形的透明边缘和字标在黑底上的亮度是否匹配。">
            <div className="flex items-center gap-7 rounded-[1.5rem] bg-[#100704] px-8 py-7">
              <SymbolMark className="h-24 w-auto -translate-y-0.5" />
              <Wordmark className="h-[6.6rem] w-auto" />
            </div>
          </PreviewCard>

          <PreviewCard title="顶部导航模拟" note="导航里建议只用小符号或小字标，不要完整横版过宽。">
            <div className="flex w-full max-w-md items-center justify-between rounded-full border border-white/70 bg-white/70 px-4 py-2 shadow-[0_12px_36px_rgba(111,58,16,0.12)] dark:border-white/10 dark:bg-black/28">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[#806044] dark:text-[#d9a468]">文件中转，就用</span>
                <SymbolMark className="h-8 w-auto" />
                <Wordmark className="h-9 w-auto" />
              </div>
              <span className="rounded-full bg-[#3d1a05] px-3 py-1 text-xs font-bold text-[#ffe0a8]">登录</span>
            </div>
          </PreviewCard>
        </div>
      </section>
    </main>
  );
}
