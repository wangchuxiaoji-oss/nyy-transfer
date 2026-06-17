export const BRAND_NAME = "拿呀²";
export const BRAND_DOMAIN = "nyy.app";
export const BRAND_WITH_DOMAIN = `${BRAND_NAME} · ${BRAND_DOMAIN}`;
export const BRAND_SLOGAN = `想传文件？${BRAND_NAME}。`;
export const BRAND_SLOGAN_SHORT = `想传文件？${BRAND_NAME}`;

export const PRODUCT_SHORT = "发文件，也收文件。浏览器直传，链接即走。";
export const PRODUCT_DESCRIPTION = "上传生成分享链接；也能创建收件链接，让对方直接提交文件。额度按当前规则实时同步。";

// SEO 核心：用户搜什么就写什么
// 用户搜索词：免费传文件、大文件传输、文件中转、文件中转站、在线传文件、临时分享链接
export const SEO_TITLE = `免费在线文件中转，拖进来就传 - ${BRAND_NAME}`;
export const SEO_DESCRIPTION = "传大文件给对方？直接拖进来，自动生成分享链接。无需注册、无需安装，支持超大文件浏览器直传。还能创建收件链接让对方提交。";
export const SEO_KEYWORDS = ["免费传文件", "文件中转站", "文件中转", "大文件传输", "在线传文件", "文件分享", "浏览器直传", "临时分享链接", "收文件", BRAND_NAME, BRAND_DOMAIN];

export const HOME_COPY = {
  title: "发文件，也收文件",
  subtitle: "上传生成分享链接；创建收件链接，也能让对方直接提交文件。",
};

export const AUTH_SIDEBAR_COPY = {
  kicker: "账号中心",
  title: "登录后，分享和收件都好管理。",
  description: "换设备也能查看链接、下载文件，并同步当前上传额度。",
  footer: `${BRAND_DOMAIN} · ${BRAND_SLOGAN_SHORT}`,
  benefits: {
    quota: {
      title: "额度同步",
      description: "剩余额度按当前规则实时显示。",
    },
    workbench: {
      title: "统一管理",
      description: "分享链接、收件入口和收到的文件都在工作台。",
    },
    login: {
      title: "少输密码",
      description: "常用设备 30 天内保持登录。",
    },
  },
};

export const AUTH_MOBILE_COPY = {
  title: "登录后管理分享与收件",
  subtitle: "额度同步 · 工作台管理 · 少输密码",
};
