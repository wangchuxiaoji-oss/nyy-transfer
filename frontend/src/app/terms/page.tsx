import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileCheck2, Mail } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { BRAND_NAME } from "@/lib/copy";

export const metadata: Metadata = {
  title: `服务条款 - ${BRAND_NAME}`,
  description: "拿呀²文件发送与收件服务条款，包括用户责任、内容处理、可用性、保留、举报与责任边界。",
  alternates: { canonical: "https://nyy.app/terms" },
  robots: { index: true, follow: true },
  openGraph: { title: `服务条款 - ${BRAND_NAME}`, description: "拿呀²文件传输服务条款", url: "https://nyy.app/terms", images: ["https://nyy.app/logo-home-preview.png"] },
  twitter: { card: "summary_large_image", images: ["https://nyy.app/logo-home-preview.png"] },
};

const sections = [
  ["1. 接受条款", "访问或使用拿呀²即表示你同意本条款和隐私政策。不同意时请停止使用。未成年人应在监护人指导下使用，并遵守所在地适用规则。"],
  ["2. 服务内容", "拿呀²提供网页端文件上传、临时分享、收件链接、文件清单、部分格式预览、下载和账号管理。具体额度、有效期、下载次数、支持格式与功能以页面实时展示为准，产品可能持续调整。"],
  ["3. 账号与凭据", "你应使用有权控制的邮箱注册，保护密码、验证码、会话、分享提取码和游客撤销令牌。因自行公开凭据、共用账号或设备失控导致的访问风险由用户承担；发现异常应及时修改密码或联系我们。"],
  ["4. 用户内容与权利", "你保留对合法上传内容的权利，并授予我们为提供存储、传输、预览、安全处理和故障排查所必需的有限处理权限。你保证有权上传和分享内容，且不会侵犯他人著作权、隐私、商业秘密或其他合法权益。"],
  ["5. 禁止行为", "不得上传或传播违法、侵权、恶意软件、钓鱼材料、未经授权的个人信息，或利用服务实施骚扰、欺诈、绕过限制、自动化滥用、破坏系统、探测他人数据与干扰正常运营。不得转售或冒充官方提供未经许可的服务。"],
  ["6. 自动处理与安全处置", "服务会处理媒体元数据、校验信息、访问日志和风险信号，也可能依据举报或安全规则限制访问、封禁分享、暂停账号、保留必要证据或删除内容。自动处理不保证识别所有风险，接收者仍应检查未知文件。"],
  ["7. 有效期、撤销与清理", "分享可能因到期、主动撤销、下载次数耗尽、违规处置或系统维护而失效。公开访问停止后，关联文件按清理流程处理，删除不一定瞬时完成。拿呀²不是长期备份，用户必须自行保存重要原件。"],
  ["8. 可用性与变更", "我们会合理维护服务，但不保证不间断、无错误或适配所有设备、网络和媒体编码。存储提供方、网络故障、浏览器限制、维护与不可抗力可能造成延迟或中断。我们可为安全、合规和产品演进调整功能。"],
  ["9. 责任边界", "在法律允许范围内，拿呀²不对用户内容、链接转发、第三方软件、间接损失、利润损失或未保留备份导致的数据损失承担超出法定范围的责任。本条款不排除法律不得排除的消费者权利。"],
  ["10. 举报、终止与联系", "发现违法、侵权或恶意分享可使用分享页举报。我们可对严重或重复违规采取限制措施。你可停止使用服务并按可用功能撤销内容。条款问题联系 admin@nyy.app。条款更新后继续使用视为接受更新版本。"],
];

export default function TermsPage() {
  return (
    <main className="nyy-product-shell min-h-dvh">
      <div className="nyy-product-content mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex items-center justify-between"><BrandLogo href="/" className="h-auto w-32" priority /><ThemeToggle /></header>
        <div className="mt-10 grid gap-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <aside><Link href="/" className="retro-nav-button px-0"><ArrowLeft className="h-4 w-4" />返回首页</Link><div className="retro-panel mt-5 p-4"><FileCheck2 className="h-5 w-5 text-orange-500" /><p className="mt-3 type-caption leading-6 retro-muted">公开可索引版本<br />最后更新：2026年7月22日</p></div></aside>
          <article><p className="retro-kicker">Terms of service</p><h1 className="retro-title mt-3 text-4xl">服务条款</h1><p className="mt-5 text-base leading-8 retro-text">这些条款说明拿呀²提供什么、用户应承担什么，以及临时文件传输服务不应被误解成什么。请在上传重要或敏感内容前阅读。</p><div className="mt-10 space-y-9">{sections.map(([title, content]) => <section key={title} className="border-t border-black/10 pt-7 dark:border-white/10"><h2 className="retro-title text-lg">{title}</h2><p className="mt-3 text-sm leading-7 retro-text">{content}</p></section>)}</div><a href="mailto:admin@nyy.app" className="retro-panel mt-10 flex min-h-[64px] items-center gap-3 p-4 hover:border-orange-400/50"><Mail className="h-5 w-5 text-orange-500" /><span><strong className="block text-sm retro-text">条款联系</strong><span className="type-caption retro-muted">admin@nyy.app</span></span></a></article>
        </div>
      </div>
    </main>
  );
}
