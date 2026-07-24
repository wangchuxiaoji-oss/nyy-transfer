import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Mail, ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `隐私政策 - ${BRAND_NAME}`,
  description: "了解拿呀²处理账号、文件、媒体元数据、访问日志、安全信号、保留与删除请求的方式。",
  alternates: { canonical: "https://nyy.app/privacy" },
  robots: { index: true, follow: true },
  openGraph: { title: `隐私政策 - ${BRAND_NAME}`, description: "拿呀²隐私政策与数据处理说明", url: "https://nyy.app/privacy", images: ["https://nyy.app/logo-home-preview.png"] },
  twitter: { card: "summary_large_image", images: ["https://nyy.app/logo-home-preview.png"] },
};

const sections = [
  ["1. 适用范围", "本政策适用于 nyy.app 提供的文件发送、收件、账号、预览、下载、举报和相关运营功能。第三方存储、邮件或浏览器能力可能受其各自政策约束。"],
  ["2. 我们处理的信息", "注册与账号流程会处理邮箱、验证码状态、登录会话和账号设置。使用服务时会处理 IP、用户代理、访客标识、请求时间、错误信息、访问与交互事件，以及配额、安全和故障排查所需日志。"],
  ["3. 文件与媒体信息", "为完成上传、目录展示、下载、预览和兼容性判断，我们会处理文件名、路径、大小、扩展名、MIME 类型、校验信息和存储标识。媒体文件可能在客户端或服务流程中分析容器、时长、音视频轨道、编码和索引位置，并可能使用预览辅助资产。我们不会宣称文件完全不被自动处理或扫描。"],
  ["4. 使用目的", "信息用于提供上传与下载授权、创建和管理分享、执行额度与有效期、恢复会话、发送验证码与服务邮件、生成预览、改进兼容性、处理举报、识别滥用、保障安全、审计管理员操作和排查故障。我们不会出售用户文件或邮箱。"],
  ["5. 分享与接收者", "持有有效分享链接及所需提取码的人可能访问对应内容。链接可能被接收者继续转发，因此发送者应选择合理有效期、下载次数并谨慎分发。收件链接提交的文件会进入创建者账号并占用其额度。"],
  ["6. 存储、保留与删除", "分享过期、撤销、封禁或达到访问限制后，公开访问会停止，关联对象按存储清理流程处理。任务队列、缓存、日志、备份和安全保留要求意味着删除不一定瞬时完成。账号、审计、安全和争议记录可能按不同周期保留。重要文件不应只保存在临时分享中。"],
  ["7. 服务提供方与跨系统处理", "为提供对象存储、邮件投递、网络加速、监控与安全能力，必要信息可能由受托服务提供方处理。我们会尽量限制数据范围，并通过访问控制和服务配置降低不必要暴露。"],
  ["8. 安全措施与限制", "我们使用 HTTPS、短期授权、访问控制、可选提取码、有效期、下载次数、管理员审计和风险处置保护服务。四位提取码不是高强度加密，拿呀²也不是端到端加密或零知识存储。用户应自行检查未知来源文件并保护账号。"],
  ["9. 你的选择与请求", "你可以撤销自己控制的分享、调整部分分享设置或停止使用服务。账号访问、更正、删除与隐私问题请使用注册邮箱联系 admin@nyy.app。为防止冒用，我们可能要求合理验证；法律、安全、争议和备份清理义务可能限制即时删除。"],
  ["10. 政策更新与联系", "功能、服务提供方或法律要求变化时，本政策会更新并修改日期。重大变化会通过适当方式提示。隐私问题请联系 admin@nyy.app，邮件中不要发送密码、验证码、提取码或原始敏感文件。"],
];

export default function PrivacyPage() {
  return (
    <main className="nyy-product-shell min-h-dvh">
      <div className="nyy-product-content mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex items-center justify-between"><BrandLogo href="/" className="h-auto w-32" priority /><ThemeToggle /></header>
        <div className="mt-10 grid gap-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <aside><Link href="/" className="retro-nav-button px-0"><ArrowLeft className="h-4 w-4" />返回首页</Link><div className="retro-panel mt-5 p-4"><ShieldCheck className="h-5 w-5 text-orange-500" /><p className="mt-3 type-caption leading-6 retro-muted">公开可索引版本<br />最后更新：2026年7月22日</p></div></aside>
          <article><p className="retro-kicker">Privacy policy</p><h1 className="retro-title mt-3 text-4xl">隐私政策</h1><p className="mt-5 text-base leading-8 retro-text">拿呀²重视准确说明。我们只为提供、保护和改进服务处理必要信息，但文件传输本身需要授权、存储、元数据与安全流程，因此不以“完全不读取”作为承诺。</p><div className="mt-10 space-y-9">{sections.map(([title, content]) => <section key={title} className="border-t border-black/10 pt-7 dark:border-white/10"><h2 className="retro-title text-lg">{title}</h2><p className="mt-3 text-sm leading-7 retro-text">{content}</p></section>)}</div><a href="mailto:admin@nyy.app" className="retro-panel mt-10 flex min-h-[64px] items-center gap-3 p-4 hover:border-orange-400/50"><Mail className="h-5 w-5 text-orange-500" /><span><strong className="block text-sm retro-text">隐私联系</strong><span className="type-caption retro-muted">admin@nyy.app</span></span></a></article>
        </div>
      </div>
    </main>
  );
}
