import {
  ArrowDownToLine,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Eye,
  FileCheck2,
  FilePlus2,
  Files,
  Film,
  FolderInput,
  GraduationCap,
  Image as ImageIcon,
  Inbox,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  MoveRight,
  Search,
  Send,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { PREVIEW_ENTRIES, PREVIEW_GROUPS } from "@/components/design-preview/preview-catalog";
import { BrandLockup, BrandSymbol, LOGO_CANDIDATES, LogoApplication, type LogoCandidate } from "@/components/design-preview/preview-logo";
import { Badge, FileRow, InlineNotice, Metric, PreviewFooter, ProductHeader, Progress, SectionHeading, SkeletonBlock, StateMessage } from "@/components/design-preview/preview-primitives";

export function OverviewScreen({ candidate }: { candidate: LogoCandidate }) {
  return (
    <div className="dp-screen dp-screen-overview">
      <ProductHeader candidate={candidate} action="退出预览" />
      <main className="dp-page dp-overview-page" id="dp-main">
        <section className="dp-overview-hero">
          <p className="dp-eyebrow">NYY DESIGN REVIEW · V2</p>
          <h1>全站新版 UI<br />在这里一次审完。</h1>
          <p>生产页面保持不变。这里集中展示 18 个正式路由、全部管理模块、核心状态、桌面端与移动端，以及十二套待选 Logo。</p>
          <div className="dp-overview-summary"><Metric label="正式路由" value="18" detail="不含实验页面" /><Metric label="后台模块" value="11" detail="含独立状态" /><Metric label="审阅视口" value="2" detail="桌面 + 移动" /><Metric label="生产数据调用" value="0" detail="全部使用 Mock" /></div>
        </section>
        <section className="dp-overview-groups">
          {PREVIEW_GROUPS.slice(1).map((group, groupIndex) => (
            <article key={group}>
              <header><span>0{groupIndex + 1}</span><div><p>{group}</p><strong>{PREVIEW_ENTRIES.filter((entry) => entry.group === group).length} 个审阅页面</strong></div></header>
              <div>{PREVIEW_ENTRIES.filter((entry) => entry.group === group).slice(0, 6).map((entry) => <span key={entry.path}>{entry.label}</span>)}</div>
            </article>
          ))}
        </section>
        <section className="dp-overview-rules" id="dp-more">
          <SectionHeading eyebrow="审阅规则" title="Preview 通过，不等于生产授权" description="每个页面可以通过、要求修改或拒绝方向。十二套 Logo 候选与首页 Hero 都不会被系统自动定稿。" />
          <div className="dp-rule-list"><span><Check /> 全部页面由本地模拟数据驱动</span><span><Check /> 亮色桌面与移动端同时呈现</span><span><Check /> 对比度、焦点和触控目标按规范设计</span><span><Check /> 正式页面与品牌资产暂不替换</span></div>
        </section>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

export function BrandScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "navigation") return <BrandNavigation candidate={candidate} />;
  if (state === "hero") return <BrandHero candidate={candidate} />;
  if (state === "icons") return <BrandIcons candidate={candidate} />;
  if (state === "social") return <BrandSocial candidate={candidate} />;

  return (
    <div className="dp-screen dp-brand-page">
      <header className="dp-brand-preview-header"><p className="dp-eyebrow">BRAND SYSTEM · 12 CANDIDATES</p><h1>四种交接语言，<br />十二个独立候选。</h1><p>旧信封方向已移除。十二套方案均使用已确认的温和圆润轮廓与统一字标，请只比较符号的识别速度、亲和度和小尺寸表现；当前高亮仅代表审阅选择，不代表定稿或推荐。</p></header>
      <main className="dp-logo-candidate-grid">
        {LOGO_CANDIDATES.map((item) => (
          <article key={item.value} className={candidate === item.value ? "dp-logo-selected" : ""}>
            <span className="dp-logo-index"><strong>方案 {item.value.toUpperCase()}</strong>{item.group}</span>
            <LogoApplication><BrandLockup candidate={item.value} /></LogoApplication>
            <LogoApplication tone="dark"><BrandLockup candidate={item.value} inverse /></LogoApplication>
            <div className="dp-logo-candidate-copy">
              <strong>{item.name}</strong>
              <p>{item.description}</p>
            </div>
          </article>
        ))}
      </main>
      <section className="dp-wordmark-study"><div><p className="dp-eyebrow">UNIFIED WORDMARK</p><h2>拿呀<sup>2</sup></h2><span>nyy.app</span></div><p>十二套符号共用这一套重绘字标：中文主标保持温和但不卡通，`²` 作为珊瑚色识别锚点，域名仅承担稳定副标。</p></section>
    </div>
  );
}

function BrandNavigation({ candidate }: { candidate: LogoCandidate }) {
  return <div className="dp-screen dp-brand-application-page"><div className="dp-application-label">导航应用 · 当前选择方案 {candidate.toUpperCase()}</div><ProductHeader candidate={candidate} /><main className="dp-brand-nav-demo"><p className="dp-eyebrow">64PX PRODUCT HEADER</p><h1>标志退后一步，任务自然成为焦点。</h1><div className="dp-brand-nav-context"><span>文件交付</span><strong>课程结业资料</strong><Badge tone="success">有效 · 2 天</Badge></div></main></div>;
}

function BrandHero({ candidate }: { candidate: LogoCandidate }) {
  return <div className="dp-screen dp-brand-application-page"><div className="dp-application-label">首页应用 · 当前选择方案 {candidate.toUpperCase()}</div><ProductHeader candidate={candidate} /><main className="dp-brand-hero-demo"><BrandSymbol candidate={candidate} className="dp-brand-hero-symbol" /><p className="dp-eyebrow">文件交付，也能向外收件</p><h1>把文件准备好。<br />剩下的是一条链接。</h1><p>适合课程资料、摄影成片、合同附件与临时项目目录。</p><button className="dp-button dp-button-primary" type="button">选择文件<ArrowRight /></button></main></div>;
}

function BrandIcons({ candidate }: { candidate: LogoCandidate }) {
  const sizes = [16, 20, 32, 56, 96, 192, 512];
  return <div className="dp-screen dp-icon-study"><header><p className="dp-eyebrow">SIZE & MONO TEST</p><h1>从 favicon 到应用图标</h1><p>16–96px 按真实像素显示；更大的应用图标在测试框内等比缩放。符号必须在没有字标、阴影和渐变的条件下保持识别。</p></header><div className="dp-icon-size-grid">{sizes.map((size) => <article key={size}><div><BrandSymbol candidate={candidate} className="dp-icon-variable" style={{ width: Math.min(size, 80), height: Math.min(size, 80) }} /></div><strong>{size}px</strong><span>{size <= 20 ? "真实 favicon" : size >= 192 ? "等比应用图标" : "真实界面尺寸"}</span></article>)}</div><div className="dp-mono-row"><LogoApplication><BrandLockup candidate={candidate} /></LogoApplication><LogoApplication tone="dark"><BrandLockup candidate={candidate} inverse /></LogoApplication><LogoApplication tone="paper"><BrandLockup candidate={candidate} /></LogoApplication></div></div>;
}

function BrandSocial({ candidate }: { candidate: LogoCandidate }) {
  return <div className="dp-screen dp-social-study"><header><p className="dp-eyebrow">SOCIAL PREVIEW · 1200 × 630</p><h1>社交图不再放大吉祥物。</h1></header><section className="dp-og-card"><div className="dp-og-grid" /><BrandLockup candidate={candidate} /><div><p>浏览器里的文件交付工具</p><h2>想传文件？<br />拿呀<sup>2</sup>。</h2><span>上传、生成链接、交给对方。</span></div><Badge>nyy.app</Badge></section></div>;
}

export function HomeScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  const heroVariant = state === "hero-b" ? "b" : "a";
  return (
    <div className="dp-screen dp-screen-home">
      <ProductHeader candidate={candidate} />
      <main id="dp-main">
        <section className={`dp-home-hero dp-home-hero-${heroVariant}`}>
          <div className="dp-home-copy"><p className="dp-eyebrow">文件交付，也能向外收件</p><h1>{heroVariant === "a" ? <>把文件准备好。<br />剩下的是一条链接。</> : <>传文件，<br />不必先解释工具。</>}</h1><p>课程资料、摄影成片、合同附件和项目目录，都用同一条清楚的交付路径。</p><div className="dp-home-trust"><span><ShieldCheck />规则提前可见</span><span><Clock3 />临时保留</span><span><Files />目录不打散</span></div></div>
          <HomeTool state={state} />
        </section>
        <section className="dp-home-proof"><span>无需安装</span><span>浏览器直传</span><span>可选访问码</span><span>真实额度提示</span></section>
        <section className="dp-home-process" id="dp-more"><SectionHeading eyebrow="一条更短的交付路径" title="打开、选择、上传、交给对方" description="产品只在需要时解释限制，不让功能矩阵挡住第一次操作。" /><div className="dp-process-list">{[["01","选择文件","单个文件、多个文件或完整目录。"],["02","确认规则","有效期、访问码和下载次数都在创建前展示。"],["03","发出链接","接收者无需安装应用，也不必先注册账号。"]].map(([number,title,copy]) => <article key={number}><span>{number}</span><div><strong>{title}</strong><p>{copy}</p></div><MoveRight /></article>)}</div></section>
        <section className="dp-home-scenarios"><SectionHeading eyebrow="跨场景，不换皮肤" title="工具保持中性，内容自然表达用途" /><div><article><GraduationCap /><strong>教育资料</strong><p>课程讲义、结业作业、课堂素材。</p><span>PDF · PPTX · ZIP</span></article><article><ImageIcon /><strong>影像交付</strong><p>摄影成片、剪辑预览、项目原片。</p><span>JPG · MOV · WAV</span></article><article><BriefcaseBusiness /><strong>商务文件</strong><p>合同附件、报价表、交付目录。</p><span>DOCX · XLSX · PDF</span></article></div></section>
        <section className="dp-home-security"><div><p className="dp-eyebrow">边界说清楚</p><h2>可信，不靠一句绝对承诺。</h2><p>HTTPS、短期授权、访问码和有效期共同控制访问。拿呀²是临时文件交付工具，不替代长期备份或端到端加密系统。</p><a href="#dp-main">查看安全说明<ArrowRight /></a></div><div className="dp-security-list"><span><ShieldCheck /><strong>访问保护</strong><small>可选 4 位访问码</small></span><span><Clock3 /><strong>明确失效</strong><small>规则创建前可见</small></span><span><FileCheck2 /><strong>原件意识</strong><small>重要内容自行备份</small></span></div></section>
        <section className="dp-home-faq"><SectionHeading eyebrow="FAQ" title="传之前，先回答常见问题" /><details open><summary>接收者需要注册吗？<ChevronDown /></summary><p>不需要。持有有效链接并通过访问控制后即可查看和下载。</p></details><details><summary>可以发送文件夹吗？<ChevronDown /></summary><p>支持的浏览器可以选择文件夹，并保留目录关系。</p></details><details><summary>适合长期保存吗？<ChevronDown /></summary><p>不适合。拿呀²负责临时交付，重要内容应保留自己的原件。</p></details></section>
      </main>
      <PreviewFooter candidate={candidate} />
    </div>
  );
}

function HomeTool({ state }: { state: string }) {
  const receive = state === "receive";
  const success = state === "send-success";
  const quotaError = state === "quota-error";
  return (
    <section className="dp-home-tool" aria-label="首页文件工具">
      <div className="dp-mode-switch"><button type="button" aria-pressed={!receive}><Send />发文件</button><button type="button" aria-pressed={receive}><Inbox />收文件</button></div>
      {success ? <div className="dp-tool-success"><span><Check /></span><p className="dp-eyebrow">分享已创建</p><h2>文件已经准备好领取</h2><div className="dp-copy-field"><code>nyy.app/A7k3Qp</code><button type="button" aria-label="复制链接"><Copy /></button></div><div className="dp-success-meta"><span>12 个文件</span><span>1.84 GB</span><span>3 天后失效</span></div></div> : receive ? <div className="dp-receive-form"><div><label>收件标题<input value="课程结业作业" readOnly /></label><label>有效期<select defaultValue="7"><option value="7">7 天</option></select></label></div><label>提交说明<textarea value="请按姓名建立文件夹，提交 PDF 和源文件。" readOnly /></label><button type="button" className="dp-button dp-button-primary">创建收件链接<ArrowRight /></button></div> : <><div className="dp-drop-zone"><UploadCloud /><strong>把文件拖到这里</strong><p>或选择文件、文件夹</p><button className="dp-button dp-button-secondary" type="button">选择文件</button></div><div className="dp-tool-meta"><span>游客额度<strong>2 GB / 日</strong></span><span>单文件<strong>最高 2 GB</strong></span><span>最长保留<strong>3 天</strong></span></div>{quotaError && <InlineNotice tone="error" title="当前文件超出剩余额度">还可上传 420 MB，请移除部分文件或登录使用更高额度。</InlineNotice>}<div className="dp-tool-settings"><button type="button">有效期：3 天<ChevronDown /></button><button type="button">访问码：关闭<ChevronDown /></button><button type="button">下载次数：50<ChevronDown /></button></div></>}
    </section>
  );
}

export function ShareScreen({ state, candidate, admin = false }: { state: string; candidate: LogoCandidate; admin?: boolean }) {
  if (state === "loading") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><div className="dp-loading-panel"><SkeletonBlock rows={6} /></div></div>;
  if (state === "expired") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><StateMessage tone="warning" title="这条分享已经失效" description="分享已过期、被撤销或达到访问限制。请联系发送者重新创建。" action="返回首页" /></div>;
  if (state === "error") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><StateMessage tone="error" title="暂时无法打开分享" description="网络请求没有完成。请检查连接后重试，文件状态不会因此改变。" action="重新加载" /></div>;
  if (state === "locked") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><section className="dp-lock-panel"><span><LockKeyhole /></span><p className="dp-eyebrow">访问保护</p><h1>输入 4 位访问码</h1><p>通过验证后才能查看文件名和下载内容。</p><div className="dp-passcode"><input aria-label="访问码第 1 位" value="" readOnly /><input aria-label="访问码第 2 位" value="" readOnly /><input aria-label="访问码第 3 位" value="" readOnly /><input aria-label="访问码第 4 位" value="" readOnly /></div><button className="dp-button dp-button-primary" type="button">验证并继续</button><small>来自 nyy.app 的临时文件分享</small></section></div>;

  const multiple = state !== "ready-single";
  return (
    <div className="dp-screen dp-share-page">
      <ProductHeader candidate={candidate} action="我也要发文件" />
      {admin && <div className="dp-admin-preview-banner"><ShieldCheck />管理员预览模式：下载和访问不会计入公开统计。<button type="button">返回管理后台</button></div>}
      <main className="dp-share-main" id="dp-main">
        <header className="dp-share-heading"><div><p className="dp-eyebrow">有人通过拿呀²分享给你</p><h1>{multiple ? "「春季课程」结业资料" : "品牌影片最终成片.mov"}</h1><p>{multiple ? "12 个文件 · 1.84 GB" : "1 个文件 · 864 MB"} · 今天 14:28 创建</p></div><div><Badge tone="success">有效 · 剩余 2 天</Badge><button type="button" className="dp-button dp-button-primary"><Download />{multiple ? "下载全部" : "下载文件"}</button></div></header>
        <section className="dp-share-layout">
          <aside className="dp-share-files"><div className="dp-file-toolbar"><label><Search /><input placeholder="搜索文件…" /></label><button type="button" aria-label="更多文件操作"><MoreHorizontal /></button></div><div className="dp-file-tree">{multiple ? <><FileRow name="01 课程讲义" meta="文件夹 · 6 项" kind="folder" action="展开" /><FileRow name="课程总结.pdf" meta="PDF · 18.4 MB" /><FileRow name="课堂影像.mp4" meta="视频 · 742 MB" kind="video" status={<Badge>可预览</Badge>} /><FileRow name="作业模板.xlsx" meta="表格 · 1.2 MB" kind="sheet" /></> : <FileRow name="品牌影片最终成片.mov" meta="4K 视频 · 864 MB" kind="video" status={<Badge>正在预览</Badge>} />}</div></aside>
          <article className="dp-share-preview"><div className="dp-preview-toolbar"><div><Badge>{multiple ? "课堂影像.mp4" : "MOV"}</Badge><span>{multiple ? "03:42 · 1920 × 1080" : "01:18 · 3840 × 2160"}</span></div><button type="button" className="dp-button dp-button-ghost"><Eye />适应窗口</button></div><div className="dp-media-stage"><div className="dp-media-frame"><Film /><span>影像内容在这里成为主要色彩</span><small>产品控件保持中性，不与画面争夺注意力</small></div></div><div className="dp-share-overview"><div><span>到期时间</span><strong>7 月 29 日 14:28</strong></div><div><span>下载次数</span><strong>3 / 50</strong></div><div><span>访问保护</span><strong>已通过</strong></div></div></article>
        </section>
      </main>
      {state === "downloading" && <div className="dp-download-dock"><div><ArrowDownToLine /><span><strong>正在保存 12 个文件</strong><small>742 MB / 1.84 GB · 18.2 MB/s</small></span></div><Progress value={41} /><button type="button" aria-label="取消下载">取消</button></div>}
    </div>
  );
}

export function RequestScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  if (state === "loading") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><div className="dp-loading-panel"><SkeletonBlock rows={5} /></div></div>;
  if (state === "locked") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><section className="dp-lock-panel"><span><KeyRound /></span><p className="dp-eyebrow">受保护的收件入口</p><h1>输入访问码后提交</h1><p>创建者设置了 4 位访问码。验证后即可选择文件。</p><div className="dp-passcode"><input aria-label="访问码第 1 位" readOnly /><input aria-label="访问码第 2 位" readOnly /><input aria-label="访问码第 3 位" readOnly /><input aria-label="访问码第 4 位" readOnly /></div><button className="dp-button dp-button-primary" type="button">验证</button></section></div>;
  if (state === "complete") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><StateMessage tone="success" title="文件已交给创建者" description="共提交 4 个文件，1.26 GB。你可以关闭页面，不需要注册账号。" action="再提交一批" /></div>;
  if (state === "error") return <div className="dp-screen dp-centered-page"><BrandLockup candidate={candidate} /><StateMessage tone="error" title="这次提交没有完成" description="网络连接中断，已上传进度仍保留在当前页面。请恢复连接后继续。" action="继续上传" /></div>;
  const uploading = state === "uploading";
  return (
    <div className="dp-screen dp-request-page">
      <ProductHeader candidate={candidate} action="返回首页" compact />
      <main className="dp-request-main" id="dp-main">
        <section className="dp-request-context"><Badge tone="info"><GraduationCap />教育资料</Badge><p className="dp-eyebrow">来自 DEX 的收件请求</p><h1>课程结业作业</h1><p>请按姓名提交 PDF 和源文件。单个文件不超过 2 GB，文件名会原样交给创建者。</p><dl><div><dt>截止时间</dt><dd>7 月 30 日 18:00</dd></div><div><dt>剩余容量</dt><dd>8.7 GB</dd></div><div><dt>最多文件</dt><dd>20 个</dd></div></dl><InlineNotice title="提交前确认">不要上传包含身份证、密码或未脱敏个人资料的文件。</InlineNotice></section>
        <section className="dp-request-tool">
          <div className="dp-drop-zone"><FolderInput /><strong>{uploading ? "正在提交 4 个文件" : "把要提交的文件拖到这里"}</strong><p>{uploading ? "保持页面打开，上传完成后会自动确认。" : "支持多选，创建者会看到原始文件名。"}</p>{!uploading && <button className="dp-button dp-button-secondary" type="button">选择文件</button>}</div>
          {uploading ? <><Progress value={68} label="设计说明.pdf" /><FileRow name="设计说明.pdf" meta="148 MB / 218 MB · 8.6 MB/s" status={<Badge tone="info">上传中</Badge>} action="暂停" /><FileRow name="源文件.zip" meta="等待上传 · 1.04 GB" kind="archive" status={<Badge>排队</Badge>} action="移除" /></> : <><div className="dp-request-empty"><FilePlus2 /><span>选择后先显示文件清单，再开始提交。</span></div><button className="dp-button dp-button-primary dp-button-block" type="button" disabled>提交文件</button></>}
        </section>
      </main>
    </div>
  );
}
