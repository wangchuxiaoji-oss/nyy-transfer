export interface PreviewState {
  value: string;
  label: string;
}

export interface PreviewEntry {
  path: string;
  group: "总览" | "品牌与核心流程" | "工作台与后台" | "内容页";
  label: string;
  route: string;
  states: PreviewState[];
  note: string;
}

const state = (value: string, label: string): PreviewState => ({ value, label });

export const PREVIEW_ENTRIES: PreviewEntry[] = [
  {
    path: "",
    group: "总览",
    label: "审阅总览",
    route: "/design-preview",
    states: [state("overview", "页面地图")],
    note: "全量 Preview 的范围、审阅顺序和未决事项。",
  },
  {
    path: "brand",
    group: "品牌与核心流程",
    label: "完整品牌套件",
    route: "品牌资产",
    states: [
      state("suite", "完整套件"),
      state("navigation", "导航应用"),
      state("hero", "首页应用"),
      state("icons", "图标尺寸"),
      state("social", "OG 与社交图"),
    ],
    note: "十二套候选覆盖几何块、连续线、负形与抽象双手四类交接手势，尚未选定最终符号。",
  },
  {
    path: "core/home",
    group: "品牌与核心流程",
    label: "首页",
    route: "/",
    states: [
      state("hero-a", "Hero A：左右布局"),
      state("hero-b", "Hero B：居中布局"),
      state("send-empty", "发文件空态"),
      state("send-success", "发文件完成"),
      state("receive", "收文件模式"),
      state("quota-error", "额度错误"),
    ],
    note: "Hero A/B 为待选结构；其余状态用于审阅同一视觉系统下的真实产品流程。",
  },
  {
    path: "core/share",
    group: "品牌与核心流程",
    label: "分享领取页",
    route: "/[code]",
    states: [
      state("loading", "加载"),
      state("locked", "访问码"),
      state("ready-single", "单文件"),
      state("ready-multiple", "多文件"),
      state("downloading", "下载中"),
      state("expired", "已过期"),
      state("error", "错误"),
    ],
    note: "影像内容负责色彩，产品工具栏和访问状态保持中性。",
  },
  {
    path: "core/request",
    group: "品牌与核心流程",
    label: "收件提交页",
    route: "/r/[code]",
    states: [
      state("loading", "加载"),
      state("locked", "访问码"),
      state("ready", "待上传"),
      state("uploading", "上传中"),
      state("complete", "完成"),
      state("error", "错误"),
    ],
    note: "适配作业、客户资料和影像素材提交，不改变产品外壳。",
  },
  {
    path: "workspace/my",
    group: "工作台与后台",
    label: "我的工作台",
    route: "/my",
    states: [
      state("loading", "加载"),
      state("shares", "分享列表"),
      state("shares-empty", "分享空态"),
      state("inbox", "收件列表"),
      state("inbox-empty", "收件空态"),
      state("editing", "编辑状态"),
    ],
    note: "同质内容使用列表而不是卡片墙，移动端保留主信息与关键操作。",
  },
  ...[
    ["overview", "运营总览"],
    ["shares", "分享管理"],
    ["reports", "举报队列"],
    ["users", "用户管理"],
    ["emails", "邮件队列"],
    ["mailbox", "管理员收件箱"],
    ["announcements", "更新发布"],
    ["quota", "配额策略"],
    ["download", "下载配置"],
    ["doubao", "豆包 Session"],
    ["diagnostics", "系统诊断"],
  ].map(([module, label]): PreviewEntry => ({
    path: `admin/${module}`,
    group: "工作台与后台",
    label,
    route: `/admin?tab=${module}`,
    states: module === "overview"
      ? [state("login", "登录"), state("loading", "加载"), state("ready", "就绪"), state("error", "错误")]
      : [state("ready", "就绪"), state("empty", "空态"), state("error", "错误")],
    note: "后台使用高密度、强扫描性的统一壳层；模块内容保留各自业务结构。",
  })),
  {
    path: "admin/share-preview",
    group: "工作台与后台",
    label: "管理员分享预览",
    route: "/admin/preview/[code]",
    states: [state("ready", "就绪"), state("expired", "过期"), state("error", "错误")],
    note: "沿用分享页结构，但始终显示明确的管理员预览上下文。",
  },
  ...[
    ["about", "关于拿呀²", "/about"],
    ["contact", "联系", "/contact"],
    ["security", "安全说明", "/security"],
    ["how-it-works", "工作原理", "/how-it-works"],
    ["large-file-transfer", "大文件传输", "/large-file-transfer"],
    ["no-signup-file-sharing", "免注册分享", "/no-signup-file-sharing"],
    ["receive-files", "在线收文件", "/receive-files"],
    ["wechat-large-file", "微信大文件", "/wechat-large-file"],
    ["privacy", "隐私政策", "/privacy"],
    ["terms", "服务条款", "/terms"],
    ["updates", "最近更新", "/updates"],
    ["not-found", "404 页面", "404"],
  ].map(([slug, label, route]): PreviewEntry => ({
    path: `content/${slug}`,
    group: "内容页",
    label,
    route,
    states: slug === "updates"
      ? [state("loading", "加载"), state("ready", "时间线"), state("empty", "空态"), state("error", "错误")]
      : [state("ready", "完整页面")],
    note: slug === "about"
      ? "现有关于页仍描述旧 Y2K 视觉语言，Preview 会标记为待更新文案，不自动改写。"
      : "使用真实标题和实际内容长度验证阅读层级。",
  })),
];

export const PREVIEW_GROUPS = ["总览", "品牌与核心流程", "工作台与后台", "内容页"] as const;

export function getPreviewEntry(path: string): PreviewEntry {
  return PREVIEW_ENTRIES.find((entry) => entry.path === path) ?? PREVIEW_ENTRIES[0];
}
