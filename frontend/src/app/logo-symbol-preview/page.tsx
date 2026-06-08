import Image from "next/image";

const imageVersion = "20260607-hug-envelope-draw";

const originalCandidate = {
  id: "03",
  name: "Hug Envelope Original",
  label: "轻抱大信封原版",
  src: `/logo-symbol-candidates/image2-arm-envelope-03-hug-envelope-alpha-trim.png?v=${imageVersion}`,
  note: "原版 #03，保留作为抽卡参考基准。",
};

const drawCandidates = [
  {
    id: "01",
    name: "Original Prompt Draw 01",
    label: "原版提示词抽卡 01",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-01-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
  {
    id: "02",
    name: "Original Prompt Draw 02",
    label: "原版提示词抽卡 02",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-02-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
  {
    id: "03",
    name: "Original Prompt Draw 03",
    label: "原版提示词抽卡 03",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-03-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
  {
    id: "04",
    name: "Original Prompt Draw 04",
    label: "原版提示词抽卡 04",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-04-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
  {
    id: "05",
    name: "Original Prompt Draw 05",
    label: "原版提示词抽卡 05",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-05-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
  {
    id: "06",
    name: "Original Prompt Draw 06",
    label: "原版提示词抽卡 06",
    src: `/logo-symbol-candidates/image2-hug-envelope-draw-06-alpha-trim.png?v=${imageVersion}`,
    note: "使用原版 #03 完整 prompt 重新生成，未追加新风格要求。",
  },
];

type Candidate = typeof originalCandidate;

function CandidateCard({ candidate, priority = false }: { candidate: Candidate; priority?: boolean }) {
  return (
    <article className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/62 shadow-[0_22px_70px_rgba(111,58,16,0.13)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.055]">
      <div className="grid grid-cols-2">
        <div className="grid aspect-square place-items-center bg-[#fff5e4] p-7 dark:bg-[#1a100a]">
          <Image src={candidate.src} alt={candidate.label} width={1024} height={1024} className="h-full w-full object-contain" priority={priority} />
        </div>
        <div className="grid aspect-square place-items-center bg-[#120906] p-7">
          <Image src={candidate.src} alt={`${candidate.label} 暗色背景`} width={1024} height={1024} className="h-full w-full object-contain" />
        </div>
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-[#d66a1d]">#{candidate.id}</p>
            <h2 className="mt-1 text-xl font-black tracking-tight">{candidate.label}</h2>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-[#9d6426] dark:text-[#e4a962]">{candidate.name}</p>
          </div>
          <div className="rounded-full bg-[#3d1a05] px-3 py-1 text-xs font-black text-[#ffe0a8] dark:bg-[#ffe0a8] dark:text-[#3d1a05]">候选</div>
        </div>
        <p className="mt-3 min-h-[3.5rem] text-sm leading-6 text-[#6f4320] dark:text-[#f5c58e]">{candidate.note}</p>
        <div className="mt-5 flex items-end gap-4 rounded-2xl border border-[#f4c37b]/50 bg-[#fff8ec]/70 p-4 dark:border-white/10 dark:bg-black/18">
          {[96, 56, 32, 20].map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <Image src={candidate.src} alt={`${candidate.label} ${size}px`} width={1024} height={1024} style={{ width: size, height: size }} className="object-contain" />
              <span className="text-[10px] font-bold text-[#a4682a] dark:text-[#d9a468]">{size}px</span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function LogoSymbolPreviewPage() {
  return (
    <main className="min-h-dvh overflow-hidden bg-[#fff7ec] px-4 py-10 text-[#3c1c07] dark:bg-[#110905] dark:text-[#fff4df]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(255,180,77,0.34),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,122,36,0.18),transparent_26%),linear-gradient(135deg,rgba(255,255,255,0.58),transparent_45%)] dark:bg-[radial-gradient(circle_at_18%_12%,rgba(255,142,61,0.18),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,210,121,0.12),transparent_26%)]" />
      <section className="relative mx-auto max-w-6xl">
        <div className="rounded-[2rem] border border-white/70 bg-white/58 p-5 shadow-[0_30px_90px_rgba(130,70,18,0.16)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.06] sm:p-8">
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.28em] text-[#d66a1d]">Nayy Symbol Lab · Original Prompt Draws</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-6xl">轻抱大信封抽卡</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#704018] dark:text-[#f6c98d]">
                这里清理为只展示原版 #03 Hug Envelope，以及使用原版 #03 完整 prompt 重新生成的 6 张抽卡。没有追加五指、写实或其它新风格要求。
              </p>
            </div>
            <div className="rounded-[1.5rem] border border-[#f4c37b]/60 bg-[#fffaf2]/80 p-5 dark:border-white/10 dark:bg-black/20">
              <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c1601c]">Current Wordmark</p>
              <Image src="/logo-main.webp?v=20260607-malt-logo" alt="当前拿呀呀字标" width={460} height={254} className="mt-3 h-auto w-full object-contain" priority />
            </div>
          </div>
        </div>

        <div className="mt-10">
          <div className="mb-6 flex items-center gap-4">
            <div className="rounded-full bg-[#3d1a05] px-4 py-2 text-sm font-black text-[#ffe0a8] dark:bg-[#ffe0a8] dark:text-[#3d1a05]">原版</div>
            <div>
              <h2 className="text-2xl font-black tracking-tight">原版 #03 Hug Envelope</h2>
              <p className="mt-1 text-sm text-[#704018] dark:text-[#f6c98d]">这张保留为判断基准。</p>
            </div>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <CandidateCard candidate={originalCandidate} priority />
          </div>
        </div>

        <div className="mt-16">
          <div className="mb-6 flex items-center gap-4">
            <div className="rounded-full bg-[#d66a1d] px-4 py-2 text-sm font-black text-white">抽卡 6 张</div>
            <div>
              <h2 className="text-2xl font-black tracking-tight">原版 prompt 新生成</h2>
              <p className="mt-1 text-sm text-[#704018] dark:text-[#f6c98d]">全部使用原版 #03 prompt，方便直接抽卡挑方向。</p>
            </div>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {drawCandidates.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
