import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Gauge,
  Gift,
  Inbox,
  LayoutDashboard,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
  Wifi,
} from "lucide-react";
import { type LogoCandidate } from "@/components/design-preview/preview-logo";
import { Badge, FileRow, InlineNotice, Metric, ProductHeader, Progress, SkeletonBlock, StateMessage } from "@/components/design-preview/preview-primitives";

export function WorkspaceScreen({ state, candidate }: { state: string; candidate: LogoCandidate }) {
  const inbox = state === "inbox" || state === "inbox-empty";
  const empty = state.endsWith("empty");
  return (
    <div className="dp-screen dp-workspace-page">
      <ProductHeader candidate={candidate} action="DEX" />
      <main className="dp-workspace-main" id="dp-main">
        <header className="dp-workspace-heading"><div><p className="dp-eyebrow">WORKSPACE</p><h1>我的工作台</h1><p>集中管理发出的分享和收到的文件，不把操作藏进卡片背面。</p></div><button type="button" className="dp-button dp-button-primary"><Plus />新建分享</button></header>
        <section className="dp-workspace-benefits"><article><span><Gift /></span><div><p>90 天保留券</p><strong>2 张可用</strong><small>最近到期：8 月 31 日</small></div></article><article><span><UserPlus /></span><div><p>邀请进度</p><strong>3 / 5 位</strong><Progress value={60} /></div></article><article><span><Gauge /></span><div><p>本月额度</p><strong>18.4 / 50 GB</strong><Progress value={37} /></div></article></section>
        <section className="dp-workspace-panel">
          <div className="dp-workspace-tabs"><button type="button" aria-pressed={!inbox}><Share2 />我的分享 <Badge>12</Badge></button><button type="button" aria-pressed={inbox}><Inbox />我的收件 <Badge>4</Badge></button></div>
          <div className="dp-list-toolbar"><label><Search /><input placeholder={inbox ? "搜索收件标题或文件…" : "搜索分享标题或短码…"} /></label><button className="dp-button dp-button-secondary" type="button"><Filter />全部状态</button></div>
          {state === "loading" ? <SkeletonBlock rows={7} /> : empty ? <WorkspaceEmpty inbox={inbox} /> : inbox ? <InboxList /> : <ShareList editing={state === "editing"} />}
          {!empty && state !== "loading" && <footer className="dp-pagination"><span>共 {inbox ? 4 : 12} 条</span><button type="button" disabled>上一页</button><button type="button" aria-current="page">1</button><button type="button">2</button><button type="button">下一页</button></footer>}
        </section>
      </main>
    </div>
  );
}

function WorkspaceEmpty({ inbox }: { inbox: boolean }) {
  return <div className="dp-empty-state">{inbox ? <Inbox /> : <Share2 />}<h2>{inbox ? "还没有收件链接" : "还没有发出的分享"}</h2><p>{inbox ? "创建一条收件链接，让客户、同事或学员直接提交文件。" : "从首页选择文件，创建后的链接会集中出现在这里。"}</p><button className="dp-button dp-button-primary" type="button">{inbox ? "创建收件链接" : "开始传文件"}<ArrowRight /></button></div>;
}

function ShareList({ editing }: { editing: boolean }) {
  return <div className="dp-workspace-list"><WorkspaceRow title="品牌影片最终交付" code="A7k3Qp" meta="1 个文件 · 864 MB" status="有效" detail="7 月 29 日到期 · 3 / 50 次下载" /><WorkspaceRow title="春季课程结业资料" code="B2m8Ls" meta="12 个文件 · 1.84 GB" status="有效" detail="7 月 30 日到期 · 8 / 100 次下载" />{editing && <div className="dp-inline-editor"><div><label>有效期<select defaultValue="7"><option value="7">延长 7 天</option></select></label><label>下载次数<select defaultValue="100"><option value="100">100 次</option></select></label><label>访问码<input placeholder="保持不变" /></label></div><span><button className="dp-button dp-button-ghost" type="button">取消</button><button className="dp-button dp-button-primary" type="button">保存修改</button></span></div>}<WorkspaceRow title="报价与合同附件" code="K9v4De" meta="5 个文件 · 42 MB" status="已过期" detail="7 月 20 日到期 · 12 / 20 次下载" /></div>;
}

function WorkspaceRow({ title, code, meta, status, detail }: { title: string; code: string; meta: string; status: string; detail: string }) {
  return <article className="dp-workspace-row"><span className="dp-workspace-file"><FileText /></span><div className="dp-workspace-copy"><div><strong>{title}</strong><Badge tone={status === "有效" ? "success" : "neutral"}>{status}</Badge></div><code>nyy.app/{code}</code><p>{meta} · {detail}</p></div><div className="dp-workspace-actions"><button type="button" aria-label="复制链接"><Copy /></button><button type="button" aria-label="打开分享"><ExternalLink /></button><button type="button" aria-label="编辑分享"><Pencil /></button><button type="button" aria-label="更多操作"><MoreHorizontal /></button></div></article>;
}

function InboxList() {
  return <div className="dp-workspace-list"><article className="dp-inbox-group"><header><span><Inbox /></span><div><strong>课程结业作业</strong><p>已收到 18 个文件 · 4.62 GB · 剩余 5 天</p></div><Badge tone="success">收件中</Badge><ChevronRight /></header><div><FileRow name="陈同学-设计说明.pdf" meta="PDF · 218 MB · 今天 14:26" action="下载" /><FileRow name="李同学-源文件.zip" meta="ZIP · 1.04 GB · 今天 11:08" kind="archive" action="下载" /></div></article><article className="dp-inbox-group"><header><span><Inbox /></span><div><strong>客户补充素材</strong><p>已收到 6 个文件 · 2.1 GB · 剩余 12 天</p></div><Badge tone="info">6 / 20</Badge><ChevronRight /></header></article></div>;
}

type AdminModule = "overview" | "shares" | "reports" | "users" | "emails" | "mailbox" | "announcements" | "quota" | "download" | "doubao" | "diagnostics";

const adminNav: Array<{ id: AdminModule; label: string; Icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "总览", Icon: LayoutDashboard },
  { id: "shares", label: "分享", Icon: Share2 },
  { id: "reports", label: "举报", Icon: AlertTriangle },
  { id: "users", label: "用户", Icon: Users },
  { id: "emails", label: "邮件", Icon: Mail },
  { id: "mailbox", label: "收件箱", Icon: Inbox },
  { id: "announcements", label: "更新发布", Icon: BellRing },
  { id: "quota", label: "配额", Icon: Gauge },
  { id: "download", label: "下载", Icon: Download },
  { id: "doubao", label: "豆包", Icon: Database },
  { id: "diagnostics", label: "诊断", Icon: Activity },
];

export function AdminScreen({ module, state, candidate }: { module: AdminModule; state: string; candidate: LogoCandidate }) {
  if (module === "overview" && state === "login") return <AdminLogin candidate={candidate} />;
  return (
    <div className="dp-screen dp-admin-page">
      <header className="dp-admin-topbar"><span className="dp-admin-brand">NYY <small>CONTROL</small></span><div><Badge tone="success"><CircleDot />生产环境</Badge><span>admin@nyy.app</span><button type="button">退出</button></div></header>
      <div className="dp-admin-layout">
        <aside className="dp-admin-sidebar"><nav aria-label="后台模块">{adminNav.map(({ id, label, Icon }, index) => <div key={id} className={index === 7 ? "dp-admin-system-start" : ""}><button type="button" aria-current={module === id ? "page" : undefined}><Icon />{label}</button></div>)}</nav></aside>
        <main className="dp-admin-content" id="dp-main"><AdminModuleContent module={module} state={state} /></main>
      </div>
    </div>
  );
}

function AdminLogin({ candidate }: { candidate: LogoCandidate }) {
  return <div className="dp-screen dp-admin-login"><ProductHeader candidate={candidate} action="返回首页" compact /><main><section><span className="dp-admin-login-mark"><ShieldCheck /></span><p className="dp-eyebrow">ADMIN CONTROL</p><h1>管理员登录</h1><p>使用管理员账号进入运营和系统控制台。</p><label>邮箱<input value="admin@nyy.app" readOnly /></label><label>密码<input type="password" value="password" readOnly /></label><button type="button" className="dp-button dp-button-primary dp-button-block">继续</button><small>登录行为会进入管理员审计记录</small></section></main></div>;
}

function AdminModuleContent({ module, state }: { module: AdminModule; state: string }) {
  const label = adminNav.find((item) => item.id === module)?.label ?? "后台";
  if (state === "loading") return <><AdminHeading eyebrow="正在同步" title={label} description="读取当前运营数据和模块状态。" /><div className="dp-admin-panel"><SkeletonBlock rows={9} /></div></>;
  if (state === "error") return <><AdminHeading eyebrow="需要处理" title={label} description="模块数据没有完整加载。" /><StateMessage tone="error" title="模块加载失败" description="请求超时或权限状态已变化，请重新加载当前模块。" action="重新加载" /></>;
  if (state === "empty") return <><AdminHeading eyebrow="暂无记录" title={label} description="筛选范围内没有可显示的数据。" /><div className="dp-admin-empty"><Inbox /><strong>当前列表为空</strong><p>调整筛选条件，或等待新的业务事件进入。</p><button className="dp-button dp-button-secondary" type="button">清除筛选</button></div></>;
  if (module === "overview") return <OverviewModule />;
  if (module === "shares") return <SharesModule />;
  if (module === "reports") return <ReportsModule />;
  if (module === "users") return <UsersModule />;
  if (module === "emails") return <EmailsModule />;
  if (module === "mailbox") return <MailboxModule />;
  if (module === "announcements") return <AnnouncementsModule />;
  if (module === "quota") return <QuotaModule />;
  if (module === "download") return <DownloadModule />;
  if (module === "doubao") return <DoubaoModule />;
  return <DiagnosticsModule />;
}

function AdminHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: string }) {
  return <header className="dp-admin-heading"><div><p className="dp-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action && <button className="dp-button dp-button-primary" type="button">{action}<ArrowRight /></button>}</header>;
}

function OverviewModule() {
  return <><AdminHeading eyebrow="OPERATIONS" title="运营总览" description="把需要处理的事件放在数字之前。" /><section className="dp-admin-alert-strip"><ShieldAlert /><div><strong>2 项需要处理</strong><span>1 条高风险举报 · 1 个失败的邮件批次</span></div><button type="button">查看队列<ArrowRight /></button></section><section className="dp-admin-metrics"><Metric label="今日上传" value="286" detail="+18.4%" /><Metric label="活跃分享" value="1,842" detail="当前公开可访问" /><Metric label="今日流量" value="428 GB" detail="上行与下载" /><Metric label="注册用户" value="12,608" detail="+42 今日新增" /></section><section className="dp-admin-dashboard-grid"><article className="dp-admin-panel dp-traffic-chart"><header><div><strong>7 日传输趋势</strong><span>单位：GB</span></div><Badge tone="info">实时更新</Badge></header><div className="dp-chart-bars">{[46,62,54,78,69,88,72].map((value,index)=><span key={index} style={{ height: `${value}%` }}><i>{value * 6}</i></span>)}</div><footer><span>07/20</span><span>07/26</span></footer></article><article className="dp-admin-panel dp-activity-feed"><header><strong>最新运营事件</strong><button type="button">全部日志</button></header>{[["举报升级","分享 /A7k3Qp 被标记为高风险","刚刚"],["配额发布","策略 v2 已预约 18:00 生效","12 分钟前"],["邮件失败","批次 mail_782 重试 3 次","28 分钟前"],["分享封禁","管理员已限制 /X4m2Kb","1 小时前"]].map(([title,copy,time])=><div key={title}><span /><p><strong>{title}</strong><small>{copy}</small></p><time>{time}</time></div>)}</article></section></>;
}

function SharesModule() {
  return <><AdminHeading eyebrow="CONTENT OPERATIONS" title="分享管理" description="按状态、所有者和风险信号定位分享。" action="导出当前结果" /><AdminToolbar placeholder="搜索短码、标题、邮箱或 IP…" /><div className="dp-admin-table"><div className="dp-table-head"><span>分享</span><span>所有者</span><span>内容</span><span>状态</span><span>创建时间</span><span /></div>{[["A7k3Qp","春季课程结业资料","dex@example.com","12 项 · 1.84 GB","有效"],["X4m2Kb","未命名分享","游客 42.83.*.*","1 项 · 218 MB","已封禁"],["K9v4De","报价与合同附件","studio@example.com","5 项 · 42 MB","已过期"]].map(([code,title,owner,content,status])=><div className="dp-table-row" key={code}><span><code>/{code}</code><strong>{title}</strong></span><span>{owner}</span><span>{content}</span><span><Badge tone={status === "有效" ? "success" : status === "已封禁" ? "error" : "neutral"}>{status}</Badge></span><span>07/26 14:28</span><span><button type="button" aria-label={`查看 ${code}`}><ChevronRight /></button></span></div>)}</div></>;
}

function ReportsModule() {
  return <><AdminHeading eyebrow="TRUST & SAFETY" title="举报队列" description="优先处理高风险内容，并保留处置依据。" /><section className="dp-report-columns"><div><h2>待处理 <Badge tone="error">3</Badge></h2>{[["恶意软件","/X4m2Kb","高风险"],["侵权内容","/P8n5Rt","需要材料"],["其他","/D3c7Va","普通"]].map(([kind,code,risk],index)=><article key={code}><span className={`dp-report-priority dp-priority-${index}`} /><div><Badge tone={index === 0 ? "error" : index === 1 ? "warning" : "neutral"}>{risk}</Badge><h3>{kind}</h3><code>{code}</code><p>举报时间：今天 {14-index}:2{index}</p></div><button type="button">开始处理</button></article>)}</div><aside className="dp-admin-panel"><p className="dp-eyebrow">处理说明</p><h2>先确认风险，再决定访问状态。</h2><ol><li>打开管理员预览，不计公开下载。</li><li>核对举报类型与可用证据。</li><li>选择封禁、驳回或请求补充材料。</li><li>处置动作进入审计记录。</li></ol></aside></section></>;
}

function UsersModule() {
  return <><AdminHeading eyebrow="ACCOUNTS" title="用户管理" description="查看账号状态、使用量和风险事件。" /><AdminToolbar placeholder="搜索邮箱或用户 ID…" /><div className="dp-admin-table"><div className="dp-table-head dp-user-cols"><span>用户</span><span>方案</span><span>本月上传</span><span>活跃分享</span><span>状态</span><span /></div>{[["dex@example.com","免费","18.4 / 50 GB","12","正常"],["studio@example.com","免费","46.2 / 50 GB","28","正常"],["risk@example.com","免费","4.1 / 50 GB","0","已封禁"]].map(([email,plan,usage,shares,status])=><div className="dp-table-row dp-user-cols" key={email}><span><strong>{email}</strong><small>注册于 2026-06-18</small></span><span>{plan}</span><span>{usage}</span><span>{shares}</span><span><Badge tone={status === "正常" ? "success" : "error"}>{status}</Badge></span><span><button type="button" aria-label={`管理 ${email}`}><MoreHorizontal /></button></span></div>)}</div></>;
}

function EmailsModule() {
  return <><AdminHeading eyebrow="DELIVERY" title="邮件队列" description="验证码、重置密码和服务邮件的投递状态。" action="刷新队列" /><section className="dp-admin-metrics"><Metric label="等待发送" value="18" /><Metric label="今日成功" value="1,284" /><Metric label="今日失败" value="7" /><Metric label="平均耗时" value="1.8s" /></section><div className="dp-admin-table"><div className="dp-table-head"><span>收件人</span><span>类型</span><span>状态</span><span>重试</span><span>更新时间</span><span /></div>{[["u***@example.com","登录验证码","已发送","0"],["s***@example.com","密码重置","重试中","2"],["a***@example.com","服务通知","失败","3"]].map(([email,type,status,retry])=><div className="dp-table-row" key={`${email}-${type}`}><span>{email}</span><span>{type}</span><span><Badge tone={status === "已发送" ? "success" : status === "失败" ? "error" : "warning"}>{status}</Badge></span><span>{retry}</span><span>14:28:06</span><span><button type="button" aria-label="查看邮件详情"><ChevronRight /></button></span></div>)}</div></>;
}

function MailboxModule() {
  return <><AdminHeading eyebrow="ADMIN MAILBOX" title="管理员收件箱" description="产品反馈、举报和安全报告集中处理。" /><section className="dp-mailbox-layout"><div className="dp-mail-list"><label><Search /><input placeholder="搜索主题或发件人…" /></label>{[["安全报告：分享权限绕过","researcher@example.com","未读","今天 13:42"],["举报分享 /X4m2Kb","user@example.com","已关联","今天 11:18"],["上传大文件中断","studio@example.com","普通","昨天 22:06"]].map(([subject,sender,status,time],index)=><button key={subject} type="button" aria-current={index === 0 ? "true" : undefined}><span /><div><strong>{subject}</strong><small>{sender}</small></div><div><Badge tone={index === 0 ? "error" : index === 1 ? "warning" : "neutral"}>{status}</Badge><time>{time}</time></div></button>)}</div><article className="dp-admin-panel dp-mail-detail"><header><Badge tone="error">安全报告</Badge><h2>安全报告：分享权限绕过</h2><p>researcher@example.com · 今天 13:42</p></header><div><p>在测试自己的分享时发现，特定请求顺序可能导致访问状态与页面显示不一致。</p><p>影响范围：需要访问码的分享。已附最小复现步骤，不包含其他用户数据。</p></div><footer><button className="dp-button dp-button-secondary" type="button">关联诊断</button><button className="dp-button dp-button-primary" type="button">回复邮件</button></footer></article></section></>;
}

function AnnouncementsModule() {
  return <><AdminHeading eyebrow="PUBLIC UPDATES" title="更新发布" description="统一管理功能更新、维护和故障公告。" action="新建公告" /><section className="dp-announcement-layout"><div className="dp-admin-panel dp-announcement-editor"><label>公告类型<select defaultValue="feature"><option value="feature">功能更新</option></select></label><label>标题<input value="版本化配额策略已上线" readOnly /></label><label>摘要<textarea value="额度周期、预约发布与历史回滚现已可用。" readOnly /></label><div><label>版本<input value="1.0.0" readOnly /></label><label>状态<select defaultValue="resolved"><option value="resolved">已完成</option></select></label></div><footer><button className="dp-button dp-button-secondary" type="button">保存草稿</button><button className="dp-button dp-button-primary" type="button">发布更新</button></footer></div><aside className="dp-announcement-preview"><p className="dp-eyebrow">PUBLIC PREVIEW</p><Badge tone="success">功能更新 · 已完成</Badge><h2>版本化配额策略已上线</h2><p>额度周期、预约发布与历史回滚现已可用。</p><time>2026 年 7 月 26 日</time></aside></section></>;
}

function QuotaModule() {
  return <><AdminHeading eyebrow="POLICY VERSION 1" title="配额策略" description="先预览影响，再发布配置。" action="查看历史" /><InlineNotice tone="info" title="当前生产策略">版本 1 正在生效，下一次预约发布为空。</InlineNotice><section className="dp-quota-layout"><div className="dp-admin-panel dp-policy-form"><h2>策略草稿</h2><div className="dp-policy-grid"><label>游客周期<select defaultValue="daily"><option value="daily">每日</option></select></label><label>游客额度<input value="2 GB" readOnly /></label><label>用户周期<select defaultValue="monthly"><option value="monthly">每月</option></select></label><label>用户额度<input value="50 GB" readOnly /></label><label>收件总容量<input value="10 GB" readOnly /></label><label>批次并发<input value="4" readOnly /></label></div><footer><button className="dp-button dp-button-secondary" type="button">保存草稿</button><button className="dp-button dp-button-primary" type="button">预览发布影响</button></footer></div><aside className="dp-admin-panel dp-policy-impact"><p className="dp-eyebrow">影响预览</p><h2>本次修改影响 2 个角色</h2><dl><div><dt>游客</dt><dd><span>2 GB / 日</span><ArrowRight /><strong>3 GB / 日</strong></dd></div><div><dt>注册用户</dt><dd><span>50 GB / 月</span><ArrowRight /><strong>保持不变</strong></dd></div></dl><InlineNotice tone="warning" title="发布前确认">已在其他窗口更新配置时，本次发布会被哈希校验阻止。</InlineNotice></aside></section></>;
}

function DownloadModule() {
  return <><AdminHeading eyebrow="CLIENT DELIVERY" title="下载配置" description="控制智能下载、离页提醒和批量保存策略。" /><section className="dp-settings-stack">{[["智能下载","根据文件大小和浏览器能力选择保存方式",true],["离页提醒","下载未完成时提醒用户保持页面打开",true],["目录写入","支持的桌面浏览器可直接写入所选目录",true],["实验性并发","增加并发请求以提升高带宽环境速度",false]].map(([title,copy,enabled])=><article key={String(title)}><div><strong>{title}</strong><p>{copy}</p></div><button type="button" role="switch" aria-checked={Boolean(enabled)} className="dp-switch"><span /></button></article>)}</section><footer className="dp-settings-footer"><span>最后保存：今天 12:18 · admin@nyy.app</span><button className="dp-button dp-button-primary" type="button">保存配置</button></footer></>;
}

function DoubaoModule() {
  return <><AdminHeading eyebrow="STORAGE SESSION" title="豆包 Session" description="查看存储会话状态并在失效时重新授权。" /><section className="dp-session-layout"><article className="dp-admin-panel dp-session-status"><span className="dp-session-icon"><Database /></span><Badge tone="success"><Wifi />连接正常</Badge><h2>Session 可用</h2><dl><div><dt>最近验证</dt><dd>今天 14:26</dd></div><div><dt>Cookie 持久化</dt><dd>已启用</dd></div><div><dt>连续成功</dt><dd>428 次</dd></div></dl><button className="dp-button dp-button-secondary" type="button"><RefreshCw />立即验证</button></article><article className="dp-admin-panel dp-session-qr"><div className="dp-qr-placeholder"><QrPattern /></div><div><p className="dp-eyebrow">仅在失效时使用</p><h2>扫码刷新 Session</h2><p>使用授权账号扫码后，系统验证并持久化新的会话信息。</p><button className="dp-button dp-button-primary" type="button">开始扫码登录</button></div></article></section></>;
}

function DiagnosticsModule() {
  return <><AdminHeading eyebrow="SYSTEM HEALTH" title="系统诊断" description="从服务状态进入问题，不用装饰性仪表盘掩盖异常。" action="运行全部检查" /><section className="dp-diagnostic-summary"><Metric label="通过" value="12" /><Metric label="警告" value="2" /><Metric label="失败" value="0" /><Metric label="最近运行" value="14:28" /></section><div className="dp-diagnostic-list">{[["PostgreSQL","连接正常 · 18ms","success"],["Redis","连接正常 · 4ms","success"],["对象存储","授权有效 · 116ms","success"],["邮件出站","7 封等待重试","warning"],["媒体检查队列","积压 28 个任务","warning"],["Nginx 访问导入","最近运行 4 分钟前","success"]].map(([name,detail,tone])=><article key={name}><span className={`dp-health-dot dp-health-${tone}`} /><div><strong>{name}</strong><p>{detail}</p></div><Badge tone={tone === "success" ? "success" : "warning"}>{tone === "success" ? "正常" : "注意"}</Badge><button type="button" aria-label={`查看 ${name}`}><ChevronRight /></button></article>)}</div></>;
}

function AdminToolbar({ placeholder }: { placeholder: string }) {
  return <div className="dp-admin-toolbar"><label><Search /><input placeholder={placeholder} /></label><button className="dp-button dp-button-secondary" type="button"><Filter />筛选</button><button className="dp-button dp-button-secondary" type="button"><SlidersHorizontal />列设置</button></div>;
}

function QrPattern() {
  return <div className="dp-qr-grid">{Array.from({ length: 49 }, (_, index) => <span key={index} data-dark={(index * 7 + index % 5) % 3 === 0 || index < 8 || index > 39 ? "true" : "false"} />)}</div>;
}
