import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  Download,
  FileCheck2,
  Gift,
  Laptop,
  Mail,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { type LogoCandidate } from "@/components/design-preview/preview-logo";
import {
  Badge,
  InlineNotice,
  Metric,
  PreviewFooter,
  ProductHeader,
  Progress,
  SectionHeading,
  SkeletonBlock,
  StateMessage,
} from "@/components/design-preview/preview-primitives";
import { SEO_PAGES } from "@/lib/seo-pages";

interface ContentScreenProps {
  pageId: string;
  state: string;
  candidate: LogoCandidate;
}

interface LegalPageContent {
  eyebrow: string;
  title: string;
  introduction: string;
  contactLabel: string;
  sections: Array<{ title: string; paragraphs: string[] }>;
}

const LEGAL_PAGES: Record<"terms" | "privacy", LegalPageContent> = {
  terms: {
    eyebrow: "服务规则",
    title: "服务条款",
    introduction: "这些条款说明拿呀²提供什么、使用者需要承担什么，以及临时文件交付服务不应被误解成什么。上传重要内容前，请先确认有效期、访问方式与自己的备份安排。",
    contactLabel: "条款联系",
    sections: [
      { title: "1. 接受条款", paragraphs: ["访问或使用拿呀²即表示你同意本条款和隐私政策。不同意时请停止使用；未成年人应在监护人指导下使用，并遵守所在地适用规则。"] },
      { title: "2. 服务内容", paragraphs: ["拿呀²提供网页端文件上传、临时分享、收件链接、文件清单、部分格式预览、下载和账号管理。具体额度、有效期、下载次数与支持格式以操作页面实时展示为准。"] },
      { title: "3. 账号与凭据", paragraphs: ["你应使用有权控制的邮箱注册，并妥善保护密码、验证码、会话、分享访问码和游客撤销凭据。发现异常时，应及时修改密码或联系我们。"] },
      { title: "4. 用户内容与权利", paragraphs: ["你保留对合法上传内容的权利，并授予我们为提供存储、传输、预览、安全处理和故障排查所必需的有限处理权限。你应确保自己有权上传和分享这些内容。"] },
      { title: "5. 禁止行为", paragraphs: ["不得上传或传播违法、侵权、恶意软件、钓鱼材料、未经授权的个人信息，也不得利用服务绕过限制、探测他人数据、破坏系统或干扰正常运营。"] },
      { title: "6. 自动处理与安全处置", paragraphs: ["服务会处理媒体元数据、校验信息、访问日志和风险信号，也可能依据举报或安全规则限制访问、封禁分享、保留必要证据或删除内容。自动处理不保证识别所有风险。"] },
      { title: "7. 有效期、撤销与清理", paragraphs: ["分享可能因到期、主动撤销、下载次数耗尽、违规处置或系统维护而失效。公开访问停止后，关联文件按清理流程处理；拿呀²不是长期备份。"] },
      { title: "8. 可用性与责任边界", paragraphs: ["我们会合理维护服务，但不保证不间断、无错误或适配所有设备与媒体编码。在法律允许范围内，用户应为自己的内容、链接分发和原件备份承担责任。"] },
      { title: "9. 举报、终止与联系", paragraphs: ["发现违法、侵权或恶意分享可使用分享页举报。条款问题请联系 admin@nyy.app，邮件中不要附带密码、验证码、访问码或原始敏感文件。"] },
    ],
  },
  privacy: {
    eyebrow: "数据处理说明",
    title: "隐私政策",
    introduction: "拿呀²只为提供、保护和改进服务处理必要信息。文件传输需要授权、存储、元数据与安全流程，因此我们不使用“完全不读取”这类无法准确兑现的承诺。",
    contactLabel: "隐私联系",
    sections: [
      { title: "1. 适用范围", paragraphs: ["本政策适用于 nyy.app 提供的文件发送、收件、账号、预览、下载、举报和相关运营功能。第三方存储、邮件或浏览器能力可能受其各自政策约束。"] },
      { title: "2. 我们处理的信息", paragraphs: ["账号流程会处理邮箱、验证码状态、登录会话和账号设置。使用服务时还会处理 IP、用户代理、请求时间、错误信息，以及配额、安全与故障排查所需日志。"] },
      { title: "3. 文件与媒体信息", paragraphs: ["为完成上传、目录展示、下载和预览，我们会处理文件名、路径、大小、扩展名、MIME 类型、校验信息和存储标识。媒体文件还可能分析容器、时长、轨道与编码信息。"] },
      { title: "4. 使用目的", paragraphs: ["信息用于提供上传与下载授权、创建和管理分享、执行额度与有效期、恢复会话、发送服务邮件、改进兼容性、处理举报和识别滥用。我们不会出售用户文件或邮箱。"] },
      { title: "5. 分享与接收者", paragraphs: ["持有有效链接并通过所需访问控制的人可能访问对应内容。链接可能被继续转发，因此发送者应选择合理有效期、下载次数，并谨慎分发访问码。"] },
      { title: "6. 存储、保留与删除", paragraphs: ["分享失效后公开访问会停止，关联对象按清理流程处理。任务队列、缓存、日志和备份意味着删除不一定瞬时完成；重要文件不应只保存在临时分享中。"] },
      { title: "7. 安全措施与限制", paragraphs: ["我们使用 HTTPS、短期授权、访问控制、有效期、下载次数、管理员审计和风险处置保护服务。四位访问码不是高强度加密，拿呀²也不是端到端加密或零知识存储。"] },
      { title: "8. 你的选择与联系", paragraphs: ["你可以撤销自己控制的分享，或使用注册邮箱联系 admin@nyy.app 请求访问、更正和删除账号信息。为防止冒用，我们可能要求合理验证。"] },
    ],
  },
};

const SEO_PAGE_IDS = [
  "contact",
  "security",
  "how-it-works",
  "large-file-transfer",
  "no-signup-file-sharing",
  "receive-files",
  "wechat-large-file",
] as const;

type SeoPageId = (typeof SEO_PAGE_IDS)[number];

function isSeoPageId(pageId: string): pageId is SeoPageId {
  return (SEO_PAGE_IDS as readonly string[]).includes(pageId);
}

export function ContentScreen({ pageId, state, candidate }: ContentScreenProps) {
  if (pageId === "terms" || pageId === "privacy") return <LegalScreen pageId={pageId} candidate={candidate} />;
  if (pageId === "forgot-password") return <ForgotPasswordScreen state={state} candidate={candidate} />;
  if (pageId === "reset-password") return <ResetPasswordScreen state={state} candidate={candidate} />;
  if (pageId === "login") return <LoginScreen state={state} candidate={candidate} />;
  if (pageId === "auth-callback") return <AuthCallbackScreen state={state} candidate={candidate} />;
  if (pageId === "download") return <DownloadScreen state={state} candidate={candidate} />;
  if (pageId === "about") return <AboutScreen candidate={candidate} />;
  if (pageId === "redeem") return <RedeemScreen state={state} candidate={candidate} />;
  if (pageId === "updates") return <UpdatesScreen state={state} candidate={candidate} />;
  if (pageId === "email-verified") return <EmailVerifiedScreen state={state} candidate={candidate} />;
  if (isSeoPageId(pageId)) return <SeoContentScreen pageId={pageId} candidate={candidate} />;
  return <NotFoundScreen candidate={candidate} />;
}

function LegalScreen({ pageId, candidate }: { pageId: "terms" | "privacy"; candidate: LogoCandidate }) {
  const page = LEGAL_PAGES[pageId];
  return (
    <div className="dp-screen dp-content-page dp-legal-page">
      <ProductHeader candidate={candidate} action="返回首页" compact />
      <main className="dp-content-main dp-reading-layout" id="dp-main">
        <aside className="dp-reading-aside">
          <a href="#dp-main" className="dp-content-back"><ArrowLeft aria-hidden="true" />返回首页</a>
          <div className="dp-reading-meta">
            {pageId === "privacy" ? <ShieldCheck aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}
            <strong>公开可索引版本</strong>
            <span>最后更新：2026 年 7 月 22 日</span>
          </div>
          <nav aria-label={`${page.title}目录`}>
            {page.sections.map((section, index) => <a key={section.title} href={`#legal-${index + 1}`}>{section.title}</a>)}
          </nav>
        </aside>
        <article className="dp-reading-article">
          <header><p className="dp-eyebrow">{page.eyebrow}</p><h1>{page.title}</h1><p>{page.introduction}</p></header>
          {page.sections.map((section, index) => (
            <section key={section.title} id={`legal-${index + 1}`}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
          <a className="dp-content-contact" href="mailto:admin@nyy.app"><Mail aria-hidden="true" /><span><strong>{page.contactLabel}</strong><small>admin@nyy.app</small></span><ArrowRight aria-hidden="true" /></a>
        </article>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function AuthFrame({ candidate, eyebrow, title, description, children }: { candidate: LogoCandidate; eyebrow: string; title: string; description: string; children: ReactNode }) {
  return (
    <div className="dp-screen dp-content-page dp-auth-page">
      <ProductHeader candidate={candidate} action="返回首页" compact />
      <main className="dp-auth-main" id="dp-main">
        <section className="dp-auth-panel">
          <header><p className="dp-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>
          {children}
        </section>
      </main>
    </div>
  );
}

function LoginScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  return (
    <AuthFrame candidate={candidate} eyebrow="账号访问" title="登录拿呀²" description="登录后可跨设备管理分享、收件与当前额度。">
      {state === "loading" ? <SkeletonBlock rows={5} /> : (
        <form className="dp-auth-form">
          {state === "error" && <InlineNotice tone="error" title="登录没有完成">邮箱或密码不正确。请检查后重试，或使用重置密码流程。</InlineNotice>}
          <label>邮箱<input type="email" value="dex@example.com" readOnly autoComplete="email" /></label>
          <label>密码<span><input type="password" value="preview-password" readOnly autoComplete="current-password" /><button type="button">显示</button></span></label>
          <div className="dp-auth-options"><label><input type="checkbox" defaultChecked />保持登录</label><a href="#dp-main">忘记密码？</a></div>
          <button className="dp-button dp-button-primary dp-button-block" type="button">登录<ArrowRight aria-hidden="true" /></button>
          <p className="dp-auth-legal">登录即表示你同意 <a href="#dp-main">服务条款</a> 和 <a href="#dp-main">隐私政策</a>。</p>
        </form>
      )}
    </AuthFrame>
  );
}

function ForgotPasswordScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  const sent = state === "sent" || state === "success";
  return (
    <AuthFrame candidate={candidate} eyebrow="账号恢复" title="忘记密码" description="输入注册邮箱。验证通过后，我们会发送一封只在短时间内有效的重置邮件。">
      <form className="dp-auth-form">
        {sent && <InlineNotice tone="success" title="重置邮件已发送">邮件已发送至 d***@example.com，有效期 15 分钟。没有收到时请检查垃圾邮件。</InlineNotice>}
        {state === "error" && <InlineNotice tone="error" title="邮件暂时无法发送">请求过于频繁，请在 58 秒后重试。我们不会在这里确认邮箱是否已注册。</InlineNotice>}
        <label>注册邮箱<input type="email" value="dex@example.com" readOnly autoComplete="email" /></label>
        <div className="dp-human-check"><ShieldCheck aria-hidden="true" /><span><strong>安全验证</strong><small>已完成本地 Preview 模拟验证</small></span><Badge tone="success">已通过</Badge></div>
        <button className="dp-button dp-button-primary dp-button-block" type="button">{sent ? "重新发送邮件" : "发送重置邮件"}<ArrowRight aria-hidden="true" /></button>
        <a className="dp-auth-return" href="#dp-main"><ArrowLeft aria-hidden="true" />返回登录</a>
      </form>
    </AuthFrame>
  );
}

function ResetPasswordScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "success" || state === "complete") {
    return <CenteredState candidate={candidate}><StateMessage tone="success" title="密码已经更新" description="所有旧的登录会话已失效。请使用新密码重新登录。" action="前往登录" /></CenteredState>;
  }
  if (state === "expired" || state === "invalid") {
    return <CenteredState candidate={candidate}><StateMessage tone="warning" title="重置链接已经失效" description="链接可能已使用或超过 15 分钟有效期。请重新发起密码重置。" action="重新获取链接" /></CenteredState>;
  }
  return (
    <AuthFrame candidate={candidate} eyebrow="账号恢复" title="设置新密码" description="新密码至少 8 位，不要与其他网站使用相同密码。">
      <form className="dp-auth-form">
        {state === "error" && <InlineNotice tone="error" title="密码没有更新">两次输入不一致，请重新确认。</InlineNotice>}
        <label>新密码<input type="password" value="new-preview-password" readOnly autoComplete="new-password" /></label>
        <label>确认新密码<input type="password" value="new-preview-password" readOnly autoComplete="new-password" /></label>
        <ul className="dp-password-rules"><li><CheckCircle2 aria-hidden="true" />至少 8 位</li><li><CheckCircle2 aria-hidden="true" />包含字母和数字</li><li><CheckCircle2 aria-hidden="true" />与原密码不同</li></ul>
        <button className="dp-button dp-button-primary dp-button-block" type="button">更新密码</button>
      </form>
    </AuthFrame>
  );
}

function AuthCallbackScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "error" || state === "invalid") {
    return <CenteredState candidate={candidate}><StateMessage tone="error" title="登录验证没有完成" description="授权信息已失效或被取消。返回登录页后可以安全重试。" action="返回登录" /></CenteredState>;
  }
  if (state === "success" || state === "complete") {
    return <CenteredState candidate={candidate}><StateMessage tone="success" title="身份验证完成" description="正在返回你之前打开的分享，账号状态已安全更新。" action="继续" /></CenteredState>;
  }
  return (
    <AuthFrame candidate={candidate} eyebrow="安全跳转" title="正在完成登录" description="正在验证一次性授权信息，请保持当前页面打开。">
      <div className="dp-callback-status"><span><RefreshCw aria-hidden="true" /></span><strong>验证账号状态</strong><p>下一步：返回 /my 工作台</p><Progress value={68} /></div>
      <InlineNotice title="无需重复操作">如果页面长时间没有继续，可以安全返回登录页重新尝试。</InlineNotice>
    </AuthFrame>
  );
}

function DownloadScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  const downloading = state === "downloading" || state === "progress";
  return (
    <div className="dp-screen dp-content-page dp-download-page">
      <ProductHeader candidate={candidate} action="返回首页" />
      <main className="dp-content-main" id="dp-main">
        <section className="dp-download-hero">
          <div><p className="dp-eyebrow">桌面下载助手</p><h1>大批文件，直接保存到项目目录。</h1><p>适用于需要保留目录结构的批量交付。普通分享和单文件下载仍然可以直接在浏览器完成。</p><div className="dp-download-actions"><button className="dp-button dp-button-primary" type="button"><Download aria-hidden="true" />下载 Windows 版</button><button className="dp-button dp-button-secondary" type="button">查看所有版本</button></div><small>版本 1.8.2 · 64 位 · 82.4 MB · 2026-07-24</small></div>
          <div className="dp-download-device"><Laptop aria-hidden="true" /><Badge tone="success">已识别 Windows 11</Badge><strong>适合当前设备</strong><span>签名发布者：NYY.APP</span></div>
        </section>
        {state === "unsupported" && <InlineNotice tone="warning" title="当前设备暂无桌面版本">iOS 和 Android 请继续使用浏览器下载；文件较大时建议转到桌面设备。</InlineNotice>}
        {state === "error" && <InlineNotice tone="error" title="安装包信息加载失败">暂时无法校验最新版本，请稍后重试，不要从非官方来源下载安装包。</InlineNotice>}
        {state === "success" && <InlineNotice tone="success" title="安装包已开始下载">请在浏览器下载列表中查看进度，并在安装前核对发布者信息。</InlineNotice>}
        {downloading && <section className="dp-download-progress"><div><Download aria-hidden="true" /><span><strong>NYY-Desktop-1.8.2.exe</strong><small>34.6 MB / 82.4 MB · 11.8 MB/s</small></span></div><Progress value={42} label="下载安装包" /></section>}
        <section className="dp-download-platforms">
          <SectionHeading eyebrow="其他平台" title="选择与你设备一致的版本" description="安装包只提供传输辅助，不接管或自动同步你的本地文件。" />
          <div><article><Laptop aria-hidden="true" /><strong>Windows</strong><span>Windows 10 及以上 · x64</span><button type="button">下载 .exe</button></article><article><Laptop aria-hidden="true" /><strong>macOS</strong><span>macOS 13 及以上 · Apple 芯片</span><button type="button">下载 .dmg</button></article><article><Smartphone aria-hidden="true" /><strong>移动设备</strong><span>无需安装，使用系统浏览器</span><button type="button">打开网页版</button></article></div>
        </section>
        <section className="dp-download-checks"><h2>安装前检查</h2><span><CheckCircle2 aria-hidden="true" />只从 nyy.app 下载</span><span><CheckCircle2 aria-hidden="true" />核对签名发布者</span><span><CheckCircle2 aria-hidden="true" />重要文件保留原始副本</span></section>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function AboutScreen({ candidate }: { candidate: LogoCandidate }) {
  return (
    <div className="dp-screen dp-content-page dp-about-page">
      <ProductHeader candidate={candidate} action="开始传文件" />
      <main className="dp-content-main" id="dp-main">
        <section className="dp-about-hero"><p className="dp-eyebrow">关于拿呀²</p><h1>让界面退后，<br />让交付本身成为主角。</h1><p>拿呀²由独立开发者 DEX 维护，面向自由职业者、小团队和普通用户，专注浏览器里的临时文件交付与收件。</p><div><Metric label="维护方式" value="独立" detail="DEX 持续维护" /><Metric label="核心入口" value="2" detail="发文件 + 收文件" /><Metric label="安装要求" value="0" detail="浏览器即可使用" /></div></section>
        <InlineNotice tone="warning" title="待确认文案">正式关于页仍描述旧 Y2K、玻璃和高对比橙色视觉；本 Preview 仅标出冲突，不在审阅前自动改写品牌叙述。</InlineNotice>
        <section className="dp-about-principles"><SectionHeading eyebrow="产品取舍" title="先把一件事做短，再解释边界" /><div>{[["01","先完成任务","打开、选择、上传、复制链接，核心工具始终在第一屏。"],["02","状态说清楚","额度、速度、失败、有效期和兼容性不藏进帮助文档。"],["03","不假装万能","临时交付不替代长期网盘、端到端加密或企业权限系统。"]].map(([number,title,copy]) => <article key={number}><span>{number}</span><h2>{title}</h2><p>{copy}</p></article>)}</div></section>
        <section className="dp-about-maintainer"><div><p className="dp-eyebrow">独立维护</p><h2>稳定性、安全修复和真实使用问题，优先于功能数量。</h2></div><p>资源有限意味着选择必须清楚：持续打磨移动上传、目录结构、播放器兼容、错误提示与后台处置，不用营销节奏堆叠表面功能。</p><a href="mailto:admin@nyy.app">联系 DEX<ArrowRight aria-hidden="true" /></a></section>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function RedeemScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "success" || state === "redeemed") {
    return <CenteredState candidate={candidate}><StateMessage tone="success" title="保留券已加入账号" description="90 天保留券 1 张已加入 dex@example.com，可在下次创建分享时选择使用。" action="查看我的权益" /></CenteredState>;
  }
  return (
    <AuthFrame candidate={candidate} eyebrow="权益兑换" title="兑换保留券" description="输入活动或邀请获得的兑换码。兑换成功后，权益会加入当前登录账号。">
      <form className="dp-auth-form dp-redeem-form">
        <span className="dp-redeem-icon"><Gift aria-hidden="true" /></span>
        {state === "error" || state === "invalid" ? <InlineNotice tone="error" title="兑换码不可用">请检查字符是否完整；此兑换码可能已使用、已过期或不适用于当前账号。</InlineNotice> : <InlineNotice title="当前账号">将兑换到 dex@example.com，兑换后不能转移到其他账号。</InlineNotice>}
        <label>兑换码<input value="NYY-90D-7K4M2Q" readOnly autoComplete="off" /></label>
        <button className="dp-button dp-button-primary dp-button-block" type="button">确认兑换</button>
        <dl className="dp-redeem-rules"><div><dt>权益内容</dt><dd>90 天分享保留券 × 1</dd></div><div><dt>适用范围</dt><dd>单次分享，不增加上传额度</dd></div><div><dt>兑换期限</dt><dd>2026 年 8 月 31 日前</dd></div></dl>
      </form>
    </AuthFrame>
  );
}

function UpdatesScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  return (
    <div className="dp-screen dp-content-page dp-updates-page">
      <ProductHeader candidate={candidate} action="返回首页" />
      <main className="dp-content-main" id="dp-main">
        <header className="dp-updates-hero"><p className="dp-eyebrow">最近更新</p><h1>每一次变化，<br />都清楚告诉你。</h1><p>记录新功能、问题修复和维护完成时间，不需要记住内部版本号。</p></header>
        <section className="dp-updates-feed" aria-labelledby="updates-heading">
          <div className="dp-updates-heading"><div><p className="dp-eyebrow">最新内容排在前面</p><h2 id="updates-heading">更新记录</h2></div>{state === "ready" && <Badge>共 4 条</Badge>}</div>
          {state === "loading" && <div className="dp-updates-loading"><SkeletonBlock rows={8} /></div>}
          {state === "empty" && <div className="dp-empty-state"><Rocket aria-hidden="true" /><h2>暂时还没有公开更新</h2><p>新功能、问题修复和维护完成后会统一记录在这里。</p><button className="dp-button dp-button-secondary" type="button">返回首页</button></div>}
          {state === "error" && <StateMessage tone="error" title="更新记录加载失败" description="网络请求没有完成。请检查连接后重试，现有产品功能不受影响。" action="重新加载" />}
          {state === "ready" && <div className="dp-update-timeline"><UpdateItem version="1.8.2" tone="success" category="功能更新" title="批量下载会保留目录结构" date="2026 年 7 月 24 日" description="支持的桌面浏览器现在可以直接选择保存目录，并在离开页面前显示未完成任务提醒。" /><UpdateItem version="1.8.1" tone="info" category="体验改进" title="分享页预览状态更清楚" date="2026 年 7 月 18 日" description="特殊编码无法在线播放时，页面会直接说明原因，并保留原文件下载入口。" /><UpdateItem version="1.8.0" tone="success" category="新功能" title="收件链接进入工作台" date="2026 年 7 月 9 日" description="创建者可以集中查看收到的文件、剩余容量和链接有效期。提交者仍然无需注册。" /><UpdateItem version="1.7.6" tone="warning" category="维护完成" title="对象存储连接已恢复" date="2026 年 6 月 28 日" description="14:12 至 14:31 的部分上传需要重试，已经完成的分享和下载不受影响。" /></div>}
        </section>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function UpdateItem({ version, tone, category, title, date, description }: { version: string; tone: "success" | "info" | "warning"; category: string; title: string; date: string; description: string }) {
  return <article className="dp-update-item"><span className="dp-update-marker">{tone === "warning" ? <Clock3 aria-hidden="true" /> : <Rocket aria-hidden="true" />}</span><div><header><Badge tone={tone}>{category}</Badge><code>{version}</code></header><h3>{title}</h3><p>{description}</p><time><Clock3 aria-hidden="true" />{date}</time></div></article>;
}

function EmailVerifiedScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "error" || state === "expired") {
    return <CenteredState candidate={candidate}><StateMessage tone="warning" title="验证链接已经失效" description="链接可能已使用或超过有效期。登录后可以重新发送验证邮件。" action="前往登录" /></CenteredState>;
  }
  if (state === "loading") {
    return <AuthFrame candidate={candidate} eyebrow="邮箱验证" title="正在确认邮箱" description="请保持页面打开，验证只会提交一次。"><SkeletonBlock rows={4} /></AuthFrame>;
  }
  return <CenteredState candidate={candidate}><StateMessage tone="success" title="邮箱已经验证" description="dex@example.com 已完成验证。账号现在可以创建收件链接并使用完整工作台。" action="进入我的工作台" /></CenteredState>;
}

function NotFoundScreen({ candidate }: { candidate: LogoCandidate }) {
  return (
    <div className="dp-screen dp-content-page dp-not-found-page">
      <ProductHeader candidate={candidate} action="返回首页" compact />
      <main id="dp-main"><span className="dp-not-found-code">404</span><p className="dp-eyebrow">页面没有找到</p><h1>这条路径没有可打开的内容。</h1><p>地址可能输入错误，页面也可能已经移动。分享链接请确认短码完整，普通内容可以从首页重新进入。</p><div><button className="dp-button dp-button-primary" type="button">返回首页<ArrowRight aria-hidden="true" /></button><button className="dp-button dp-button-secondary" type="button">检查分享链接</button></div></main>
    </div>
  );
}

function SeoContentScreen({ pageId, candidate }: { pageId: SeoPageId; candidate: LogoCandidate }) {
  const page = SEO_PAGES[pageId];
  return (
    <div className="dp-screen dp-content-page dp-seo-page">
      <ProductHeader candidate={candidate} action="首页工具" />
      <main className="dp-content-main" id="dp-main">
        <nav className="dp-breadcrumb" aria-label="面包屑"><a href="#dp-main">首页</a><span>/</span><span>{page.title.split("：")[0]}</span></nav>
        <header className="dp-seo-hero"><div><p className="dp-eyebrow">{page.eyebrow}</p><h1>{page.headline}</h1><p>{page.lead}</p></div><aside><strong>直接回答</strong><p>{page.directAnswer}</p></aside></header>
        <div className="dp-reading-layout dp-seo-reading">
          <aside className="dp-reading-aside"><p className="dp-eyebrow">本文目录</p><nav aria-label="本文目录">{page.sections.map((section, index) => <a key={section.title} href={`#seo-${index + 1}`}><span>0{index + 1}</span>{section.title}</a>)}<a href="#seo-faq"><span>05</span>常见问题</a></nav></aside>
          <article className="dp-reading-article">
            {page.sections.map((section, index) => <section key={section.title} id={`seo-${index + 1}`}><span className="dp-section-number">0{index + 1}</span><div><h2>{section.title}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div></section>)}
            <section id="seo-faq" className="dp-content-faq"><p className="dp-eyebrow">FAQ</p><h2>常见问题</h2>{page.faqs.map((faq, index) => <details key={faq.question} open={index === 0}><summary>{faq.question}<span>+</span></summary><p>{faq.answer}</p></details>)}</section>
          </article>
        </div>
        {pageId === "contact" ? <a className="dp-content-cta" href="mailto:admin@nyy.app"><Mail aria-hidden="true" /><span><strong>admin@nyy.app</strong><small>请先移除密码、访问码和原始敏感文件</small></span><ArrowRight aria-hidden="true" /></a> : <section className="dp-content-cta"><BookOpen aria-hidden="true" /><span><strong>说明读完，回到工具直接试一次。</strong><small>当前额度和可用选项以首页实时展示为准。</small></span><button className="dp-button dp-button-primary" type="button">开始传文件</button></section>}
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function CenteredState({ candidate, children }: { candidate: LogoCandidate; children: ReactNode }) {
  return <div className="dp-screen dp-content-page dp-centered-page"><ProductHeader candidate={candidate} action="返回首页" compact /><main id="dp-main">{children}</main></div>;
}
