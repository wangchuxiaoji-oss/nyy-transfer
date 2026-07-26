"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform, useInView, AnimatePresence } from "framer-motion";
import { ArrowRight, ChevronDown, Clock3, FileCheck2, FolderInput, Link2, ScanLine, ShieldCheck } from "lucide-react";
import { BRAND_NAME } from "@/lib/copy";
import { HOME_FAQS } from "@/lib/home-faqs";

// 重新导出，供其他组件从 @/components/home-story 导入
export { HOME_FAQS };

/* ─── 步骤数据 ─── */
const steps = [
  { number: "01", title: "选好要交的文件", text: "选择单个文件、多个文件或完整文件夹，再确认有效期、提取码和下载次数。", Icon: FolderInput },
  { number: "02", title: "上传并生成链接", text: "浏览器直接上传文件，页面显示进度；大文件按支持能力分段处理并保留失败重试。", Icon: ScanLine },
  { number: "03", title: "发给对方领取", text: "复制链接或二维码发给对方。接收者无需安装应用，也不必先注册账号。", Icon: Link2 },
];

/* ─── 统计数据 ─── */
const stats = [
  { value: 2, suffix: "GB", label: "游客 24 小时额度" },
  { value: 3, suffix: "天", label: "游客最长分享" },
  { value: 50, suffix: "GB", label: "用户 30 天额度" },
];

const particles = Array.from({ length: 18 }, (_, index) => ({
  size: 2 + ((index * 3) % 5),
  left: (index * 37 + 11) % 100,
  top: (index * 53 + 7) % 100,
  x: ((index % 7) - 3) * 18,
  y: -48 - (index % 5) * 18,
  duration: 7 + (index % 6) * 1.2,
  delay: (index % 8) * 0.45,
}));

/* ─── 工具函数 ─── */

/** 数字计数动画 Hook */
function useCountUp(target: number, inView: boolean, duration = 1800) {
  const [count, setCount] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo 缓动
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setCount(Math.round(eased * target));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [inView, target, duration]);

  return count;
}

/* ─── 子组件 ─── */

/** 渐变球体背景 */
function GradientOrbs() {
  return (
    <div
      data-testid="hero-atmosphere"
      className="pointer-events-none absolute inset-y-0 -inset-x-[10vw] overflow-hidden"
      style={{
        WebkitMaskImage: "linear-gradient(to bottom, #000 0%, #000 72%, transparent 100%)",
        maskImage: "linear-gradient(to bottom, #000 0%, #000 72%, transparent 100%)",
      }}
      aria-hidden="true"
    >
      {/* 橙色主球 */}
      <div
        className="absolute -left-32 -top-32 h-[500px] w-[500px] rounded-full opacity-60"
        style={{
          background: "radial-gradient(circle, rgba(255,138,61,0.4) 0%, transparent 70%)",
          animation: "gradient-orb-drift 20s ease-in-out infinite",
        }}
      />
      {/* 青色副球 */}
      <div
        className="absolute -bottom-24 -right-24 h-[400px] w-[400px] rounded-full opacity-40"
        style={{
          background: "radial-gradient(circle, rgba(0,212,255,0.35) 0%, transparent 70%)",
          animation: "gradient-orb-drift 25s ease-in-out infinite reverse",
        }}
      />
      {/* 紫色点缀球 */}
      <div
        className="absolute left-1/3 top-1/4 h-[300px] w-[300px] rounded-full opacity-30"
        style={{
          background: "radial-gradient(circle, rgba(255,51,102,0.3) 0%, transparent 70%)",
          animation: "gradient-orb-drift 18s ease-in-out infinite 2s",
        }}
      />
      {/* 网格线背景 */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,138,61,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,138,61,0.05) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          animation: "grid-fade 8s ease-in-out infinite",
        }}
      />
      {/* 飘浮粒子 */}
      {particles.map((particle, index) => (
        <div
          key={index}
          className={`hero-particle absolute rounded-full ${index >= 10 ? "hidden sm:block" : ""}`}
          style={{
            width: `${particle.size}px`,
            height: `${particle.size}px`,
            left: `${particle.left}%`,
            top: `${particle.top}%`,
            background: index % 3 === 0 ? "rgba(255,138,61,0.6)" : index % 3 === 1 ? "rgba(0,212,255,0.5)" : "rgba(255,51,102,0.4)",
            "--px": `${particle.x}px`,
            "--py": `${particle.y}px`,
            animation: `particle-float ${particle.duration}s ease-in-out ${particle.delay}s infinite`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

/** 逐字揭示文字 */
function CharReveal({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  return (
    <span className={`char-reveal ${className || ""}`}>
      {text.split("").map((char, i) => (
        <span key={i} style={{ "--delay": `${delay + i * 0.04}s` } as React.CSSProperties}>
          {char === " " ? "\u00a0" : char}
        </span>
      ))}
    </span>
  );
}

/** Hero 区域 */
function HeroSection() {
  return (
    <motion.section
      data-testid="home-hero"
      className="relative isolate flex w-full flex-col items-center justify-center overflow-x-clip"
      aria-labelledby="hero-title"
    >
      <GradientOrbs />

      <motion.div className="relative z-10 w-full max-w-5xl px-4 pb-12 pt-28 text-center sm:px-6 sm:pb-14 sm:pt-32 lg:pb-10 lg:pt-28 2xl:pb-12 2xl:pt-32">
        {/* 品牌标记 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="mb-6"
        >
          <span className="retro-chip">
            <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-orange-500" style={{ animation: "pulse-ring 2s ease-in-out infinite" }} />
            临时文件交付 · 也能向外收件
          </span>
        </motion.div>

        {/* 主标题 */}
        <motion.h1
          id="hero-title"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="retro-title text-4xl leading-tight sm:text-6xl lg:text-7xl"
        >
          <span className="hero-gradient-text hero-title-glow inline-block" data-text="文件交付">
            文件交付
          </span>
          <br />
          <span className="mt-2 block">
            <CharReveal text="发一个链接就够了" delay={0.8} />
          </span>
        </motion.h1>

        {/* 副标题 */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="retro-text mx-auto mt-6 max-w-xl text-base leading-relaxed sm:text-lg"
        >
          设计定稿、照片成片、报告附件和外包成果，上传后生成带有效期的领取链接，对方无需注册或安装。<br className="hidden sm:block" />
          需要收资料时，再创建一条收件链接。
        </motion.p>

        <p className="retro-muted mt-7 text-xs sm:text-sm">游客免注册 · 2GB / 24小时 · 分享最长3天</p>
      </motion.div>

    </motion.section>
  );
}

/** 三步流程（水平时间线 + 滚动联动进度） */
function StepsSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const inView = useInView(sectionRef, { once: true, margin: "-80px" });

  // 滚动联动进度：当 steps section 进入视口时，进度条从 0→1
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start 0.8", "end 0.4"],
  });
  const lineWidth = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

  return (
    <section ref={sectionRef} aria-labelledby="steps-title" className="relative mt-24 w-full max-w-5xl px-4 sm:mt-32">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="text-center"
      >
        <p className="retro-kicker">从文件到交付</p>
        <h2 id="steps-title" className="retro-title mt-3 text-2xl leading-tight sm:text-4xl">三步，把文件交到对方手里</h2>
      </motion.div>

      <div className="relative mt-14">
        {/* 连接线背景 */}
        <div className="absolute left-0 right-0 top-6 h-px bg-black/8 dark:bg-white/10" aria-hidden="true" />
        {/* 滚动进度线 */}
        <motion.div
          className="absolute left-0 top-6 h-1 rounded-full bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400 progress-glow"
          style={{ width: lineWidth }}
          aria-hidden="true"
        />

        <div className="relative grid gap-8 md:grid-cols-3">
          {steps.map(({ number, title, text, Icon }, index) => (
            <motion.article
              key={number}
              initial={{ opacity: 0, y: 40 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6, delay: 0.15 * index, ease: [0.22, 1, 0.36, 1] }}
              className="relative text-center"
            >
              {/* 节点圆圈 */}
              <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full border-2 border-orange-400/40 bg-gradient-to-br from-orange-500/20 to-orange-400/10 text-orange-500 shadow-lg"
                style={{ animation: inView ? `timeline-node-pulse 2s ease-in-out ${index * 0.3}s infinite` : "none" }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <span className="font-mono text-xs font-bold tracking-[0.18em] text-orange-600 dark:text-orange-300">STEP {number}</span>
              <h3 className="retro-title mt-3 text-xl">{title}</h3>
              <p className="retro-text mt-2 text-sm leading-6">{text}</p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}

/** 数据统计（数字计数动画） */
function StatsSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="mt-24 w-full max-w-4xl px-4 sm:mt-32">
      <div className="grid grid-cols-3 gap-4">
        {stats.map(({ value, suffix, label }, index) => (
          <StatCard key={label} value={value} suffix={suffix} label={label} inView={inView} delay={index * 0.12} />
        ))}
      </div>
    </section>
  );
}

function StatCard({ value, suffix, label, inView, delay }: { value: number; suffix: string; label: string; inView: boolean; delay: number }) {
  const count = useCountUp(value, inView, 1800);
  const isComplete = count === value;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.9 }}
      animate={inView ? { opacity: 1, y: 0, scale: 1 } : {}}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`retro-card group relative overflow-hidden p-5 text-center sm:p-6 ${isComplete ? "stat-complete" : ""}`}
    >
      {/* 悬停发光扫描线 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <div
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-orange-500/10 to-transparent"
          style={{ animation: "glow-sweep 2s ease-in-out infinite" }}
        />
      </div>
      {/* 完成时的光环 */}
      {isComplete && (
        <div className="pointer-events-none absolute inset-0 rounded-2xl border border-orange-400/30 opacity-60" style={{ animation: "pulse-ring 2s ease-in-out infinite" }} />
      )}
      <div className="relative">
        <span className="retro-title text-3xl font-bold sm:text-4xl" style={inView ? { animation: `counter-pop 0.4s ease ${delay + 1.6}s` } : {}}>
          {count}
          <span className="text-lg text-orange-500">{suffix}</span>
        </span>
        <p className="retro-text mt-2 text-xs sm:text-sm">{label}</p>
      </div>
    </motion.div>
  );
}

/** 场景卡片（交错入场） */
function ScenesSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  const scenes = [
    { title: "客户交付", text: "把设计定稿、照片成片、报告附件或外包成果放进一个链接，让客户按原文件名和目录领取。", Icon: FileCheck2 },
    { title: "向外收资料", text: "创建收件链接，让客户、供应商或学员直接提交文件，不必逐个添加好友和催附件。", Icon: FolderInput },
    { title: "微信中转", text: "文件不适合塞进聊天窗口时，先上传，再把领取链接发进微信。", Icon: Link2 },
    { title: "跨设备取件", text: "电脑上传后复制链接或扫码，在手机、平板或另一台电脑上继续访问。", Icon: ScanLine },
  ];

  return (
    <section ref={ref} aria-labelledby="scenes-title" className="mt-24 w-full max-w-5xl px-4 sm:mt-32">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7 }}
        className="text-center"
      >
        <p className="retro-kicker">真实使用场景</p>
        <h2 id="scenes-title" className="retro-title mt-3 text-2xl sm:text-3xl">文件已经准备好，接下来只差交到对方手里</h2>
      </motion.div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {scenes.map(({ title, text, Icon }, index) => (
          <motion.article
            key={title}
            initial={{ opacity: 0, y: 40 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.1 * index, ease: [0.22, 1, 0.36, 1] }}
            className="relative h-full"
          >
            <div className="retro-card retro-card-3d group relative h-full overflow-hidden p-5 sm:p-6">
              {/* 悬停发光边框 */}
              <div className="pointer-events-none absolute inset-0 rounded-2xl border border-transparent transition-colors duration-300 group-hover:border-orange-400/30" />
              {/* 悬停光晕 */}
              <div className="pointer-events-none absolute -inset-1 rounded-2xl bg-gradient-to-br from-orange-500/0 via-orange-500/0 to-orange-500/0 opacity-0 transition-opacity duration-500 group-hover:from-orange-500/5 group-hover:via-transparent group-hover:to-cyan-500/5 group-hover:opacity-100" />
              <Icon className="h-5 w-5 text-orange-500 transition-all duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_0_8px_rgba(255,138,61,0.6)]" />
              <h3 className="retro-title mt-4 text-lg">{title}</h3>
              <p className="retro-text mt-2 text-sm leading-6">{text}</p>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}

/** 安全区块 */
function SecuritySection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section ref={ref} aria-labelledby="security-title" className="mt-24 w-full max-w-5xl px-4 sm:mt-32">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7 }}
        className="overflow-hidden rounded-[2rem] border border-black/10 bg-white/55 shadow-[0_24px_70px_rgba(255,138,61,0.1)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.045]"
      >
        <div className="grid lg:grid-cols-[1fr_0.86fr]">
          <div className="p-7 sm:p-10 lg:p-12">
            <p className="retro-kicker">安全与保留策略</p>
            <h2 id="security-title" className="retro-title mt-3 text-2xl leading-tight sm:text-3xl">分享前，规则就摆在明面上</h2>
            <div className="mt-7 space-y-6">
              <div className="flex gap-4"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" /><div><h3 className="font-semibold retro-text">HTTPS 传输，不等于端到端加密</h3><p className="mt-1 text-sm leading-6 retro-muted">网页与接口通过 HTTPS 传输，但拿呀²不是端到端加密或零知识存储。</p></div></div>
              <div className="flex gap-4"><Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" /><div><h3 className="font-semibold retro-text">失效与清理分开处理</h3><p className="mt-1 text-sm leading-6 retro-muted">分享过期、撤销、封禁或达到下载次数后，公开访问停止，底层对象随后进入清理流程。</p></div></div>
              <div className="flex gap-4"><FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" /><div><h3 className="font-semibold retro-text">重要资料始终保留原件</h3><p className="mt-1 text-sm leading-6 retro-muted">拿呀²负责临时传输，不替代长期备份；重要资料始终保留自己的原件。</p></div></div>
            </div>
          </div>
          <div className="relative flex min-h-[320px] items-end overflow-hidden bg-[#2a1520] p-7 text-white sm:p-10 dark:bg-[#110818]">
            <div className="absolute inset-0 opacity-70 [background:radial-gradient(circle_at_20%_18%,rgba(255,138,61,.34),transparent_35%),radial-gradient(circle_at_85%_70%,rgba(0,212,255,.16),transparent_38%)]" />
            <div className="absolute left-10 top-10 h-32 w-24 rounded-2xl border border-white/15 bg-white/[0.06] shadow-2xl backdrop-blur-xl" style={{ "--float-rotation": "-6deg", animation: "float-subtle 6s ease-in-out infinite" } as React.CSSProperties} />
            <div className="absolute right-8 top-24 h-36 w-28 rounded-2xl border border-orange-300/25 bg-orange-400/10 shadow-2xl backdrop-blur-xl" style={{ "--float-rotation": "6deg", animation: "float-subtle 6s ease-in-out infinite 1s" } as React.CSSProperties} />
            <div className="relative">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-200/60">retention is a setting</p>
              <p className="mt-3 max-w-sm text-2xl font-semibold leading-tight">把「多久后失效」变成每次分享都看得见的决定。</p>
              <Link href="/security" className="mt-6 inline-flex min-h-[44px] items-center gap-2 text-sm font-semibold text-orange-200 hover:text-white">查看安全说明 <ArrowRight className="h-4 w-4" /></Link>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

/** 差异化（左侧 sticky + 右侧列表） */
function DifferenceSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  const items = [
    ["先发再注册", "游客可以直接选择文件。只有需要更高额度、长期管理或创建收件链接时才需要登录。"],
    ["目录不打散", "多文件和文件夹按原有路径组织，接收者拿到的是一份结构清楚的交付。"],
    ["发与收分开", "交付文件时生成领取链接；收集资料时生成收件链接，每个入口只处理一件事。"],
    ["规则提前可见", "剩余额度、有效期、提取码和下载次数都在创建前展示。"],
  ];

  return (
    <section ref={ref} aria-labelledby="diff-title" className="mt-24 w-full max-w-5xl px-4 sm:mt-32">
      <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.7 }}
          className="lg:sticky lg:top-28"
        >
          <p className="retro-kicker">为什么是拿呀²</p>
          <h2 id="diff-title" className="retro-title mt-3 text-3xl leading-tight">不是网盘首页，是一条更短的交付路径</h2>
          <p className="mt-4 text-sm leading-7 retro-text">先选择文件、生成链接、让对方领取；需要收资料时，再换成一条收件链接。</p>
        </motion.div>
        <div className="divide-y divide-black/10 overflow-hidden rounded-[2rem] border border-black/10 bg-white/50 px-5 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.04] sm:px-8">
          {items.map(([title, text], index) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, x: 30 }}
              animate={inView ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.1 * index }}
              className="grid gap-3 py-6 sm:grid-cols-[3rem_9rem_1fr] sm:items-start"
            >
              <span className="font-mono text-xs text-orange-500">0{index + 1}</span>
              <h3 className="retro-title text-base">{title}</h3>
              <p className="text-sm leading-6 retro-text">{text}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** FAQ 手风琴（弹簧动画） */
function FaqSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section ref={ref} aria-labelledby="faq-title" className="mt-24 w-full max-w-3xl px-4 sm:mt-32">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7 }}
        className="text-center"
      >
        <p className="retro-kicker">FAQ</p>
        <h2 id="faq-title" className="retro-title mt-3 text-3xl">传之前，常见问题先回答</h2>
      </motion.div>

      <div className="mt-9 space-y-3">
        {HOME_FAQS.map((item, index) => (
          <motion.div
            key={item.question}
            initial={{ opacity: 0, y: 20 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5, delay: 0.08 * index }}
          >
            <FaqItem
              item={item}
              isOpen={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
            />
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function FaqItem({ item, isOpen, onToggle }: { item: { question: string; answer: string }; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="retro-panel overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[60px] w-full cursor-pointer items-center justify-between gap-4 px-5 py-3 text-left font-semibold retro-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 sm:px-6"
        aria-expanded={isOpen}
      >
        <span>{item.question}</span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="shrink-0 text-orange-500"
        >
          <ChevronDown className="h-5 w-5" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            className="overflow-hidden"
          >
            <p className="border-t border-black/8 px-5 pb-5 pt-4 text-sm leading-7 retro-text dark:border-white/10 sm:px-6">
              {item.answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** CTA 区域（极光渐变 + 脉冲发光） */
function CtaSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="mt-24 w-full max-w-5xl px-4 sm:mt-32">
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={inView ? { opacity: 1, y: 0, scale: 1 } : {}}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="home-final-cta relative overflow-hidden rounded-[2.25rem] border border-orange-300/30 px-6 py-14 text-center text-white shadow-[0_30px_90px_rgba(64,23,8,0.25)] sm:px-12 sm:py-20 aurora-bg"
      >
        {/* 极光装饰层 */}
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-orange-500/30 blur-3xl" style={{ animation: "gradient-orb-drift 15s ease-in-out infinite" }} />
          <div className="absolute -bottom-16 -right-16 h-48 w-48 rounded-full bg-cyan-500/25 blur-3xl" style={{ animation: "gradient-orb-drift 18s ease-in-out infinite reverse" }} />
          <div className="absolute left-1/2 top-1/3 -ml-20 h-40 w-40 rounded-full bg-purple-500/20 blur-3xl" style={{ animation: "gradient-orb-drift 12s ease-in-out infinite 3s" }} />
        </div>
        {/* 渐变覆盖 */}
        <div className="absolute inset-0 [background:radial-gradient(circle_at_12%_15%,rgba(255,138,61,.25),transparent_30%),radial-gradient(circle_at_88%_82%,rgba(0,212,255,.15),transparent_32%)]" />
        <div className="relative">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-orange-200/60">Ready when the file is</p>
          <h2 className="mx-auto mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-tight sm:text-5xl hero-title-glow">文件准备好了，就发一条链接。</h2>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-7 text-white/60">先选文件，再决定有效期和访问方式。需要收资料时，切到“收文件”创建入口。</p>
          <a
            href="#upload-section"
            className="btn-primary mt-8 inline-flex min-w-44 items-center gap-2"
            style={{ animation: "cta-glow-breathe 3s ease-in-out infinite" }}
          >
            选择文件发送 <ArrowRight className="h-4 w-4" />
          </a>
          <Link
            href="/?mode=receive#upload-section"
            onClick={() => window.dispatchEvent(new CustomEvent("nyy:home-mode", { detail: "receive" }))}
            className="retro-btn-secondary ml-0 mt-3 inline-flex min-w-44 items-center justify-center sm:ml-3 sm:mt-8"
          >
            创建收件链接
          </Link>
        </div>
      </motion.div>
    </section>
  );
}

/** 页脚 */
function Footer() {
  return (
    <footer className="mt-12 flex w-full max-w-5xl flex-col gap-5 border-t border-black/10 py-8 text-sm retro-muted dark:border-white/10 sm:flex-row sm:items-center sm:justify-between">
      <p>© 2026 {BRAND_NAME} · 独立维护的文件传输工具</p>
      <nav aria-label="页脚导航" className="flex flex-wrap gap-x-5 gap-y-3">
        <Link href="/how-it-works" className="hover:text-orange-500">工作原理</Link>
        <Link href="/security" className="hover:text-orange-500">安全</Link>
        <Link href="/updates" className="hover:text-orange-500">最近更新</Link>
        <Link href="/about" className="hover:text-orange-500">关于</Link>
        <Link href="/contact" className="hover:text-orange-500">联系</Link>
        <Link href="/privacy" className="hover:text-orange-500">隐私</Link>
        <Link href="/terms" className="hover:text-orange-500">条款</Link>
      </nav>
    </footer>
  );
}

/* ─── 主组件：Hero（全屏沉浸式） ─── */
export function HomeHero() {
  return (
    <div className="home-hero relative -mx-4 w-[calc(100%+2rem)] max-w-none">
      <HeroSection />
    </div>
  );
}

/* ─── 主组件：营销内容（步骤 · 统计 · 场景 · 安全 · 差异化 · FAQ · CTA · 页脚） ─── */
export function HomeStory() {
  return (
    <div className="home-story mt-0 w-full max-w-5xl sm:mt-0">
      <StepsSection />
      <StatsSection />
      <ScenesSection />
      <SecuritySection />
      <DifferenceSection />
      <FaqSection />
      <CtaSection />
      <Footer />
    </div>
  );
}
