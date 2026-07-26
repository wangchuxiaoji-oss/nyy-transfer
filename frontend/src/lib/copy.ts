export const BRAND_NAME = "拿呀²";
export const BRAND_DOMAIN = "nyy.app";
export const BRAND_WITH_DOMAIN = `${BRAND_NAME} · ${BRAND_DOMAIN}`;
export const BRAND_SLOGAN = `想传文件？${BRAND_NAME}。`;
export const BRAND_SLOGAN_SHORT = `想传文件？${BRAND_NAME}`;

export const PRODUCT_SHORT = "临时交付文件，也能向外收件。上传后生成链接，对方无需安装。";
export const PRODUCT_DESCRIPTION = "上传文件生成带有效期的领取链接；也能创建收件链接，让对方无需账号直接提交。";

// SEO 核心：用户搜什么就写什么
// 用户搜索词：免费传文件、大文件传输、文件中转、文件中转站、在线传文件、临时分享链接
export const SEO_TITLE = `免费在线传文件与收文件 - ${BRAND_NAME}`;
export const SEO_DESCRIPTION = "上传设计稿、照片成片、报告附件和外包成果，生成临时领取链接；也能创建收件链接集中收资料。无需安装，游客单文件最高2GB。";
export const SEO_KEYWORDS = ["免费传文件", "文件中转站", "文件中转", "大文件传输", "在线传文件", "文件分享", "浏览器直传", "临时分享链接", "收文件", BRAND_NAME, BRAND_DOMAIN];

export const HOME_COPY = {
  title: "文件交付，发一个链接就够了",
  subtitle: "临时交付文件，也能创建收件链接向外收资料。",
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
