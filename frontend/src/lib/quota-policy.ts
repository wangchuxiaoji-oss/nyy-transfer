export interface SendQuotaPolicy {
  period_kind: "daily" | "monthly";
  period_limit_bytes: number;
  max_file_bytes: number;
  max_share_bytes: number;
  max_files_per_share: number;
  max_empty_dirs_per_share: number;
  max_active_shares: number;
  max_concurrent_upload_batches: number;
  default_retention_hours: number;
  retention_options_hours: number[];
  default_max_downloads: number;
  download_options: number[];
}

export interface ReceiveQuotaPolicy {
  enabled: boolean;
  max_active_requests: number;
  max_request_bytes: number;
  max_file_bytes: number;
  max_files_per_request: number;
  default_retention_hours: number;
  retention_options_hours: number[];
}

export interface QuotaPolicyConfig {
  timezone: "Asia/Shanghai";
  guest: SendQuotaPolicy;
  user: SendQuotaPolicy;
  receive: ReceiveQuotaPolicy;
  retention_coupon_hours: number;
}

export interface PublicQuotaPolicy {
  version: number;
  effective_at: string;
  config: QuotaPolicyConfig;
  technical: {
    max_file_bytes: number;
    max_share_bytes: number;
    max_files_per_share: number;
    max_empty_dirs_per_share: number;
    max_retention_hours: number;
    max_active_links: number;
    max_concurrent_upload_batches: number;
    max_request_bytes: number;
    max_request_files: number;
  };
}

const GiB = 1024 ** 3;

export const DEFAULT_QUOTA_POLICY: PublicQuotaPolicy = {
  version: 0,
  effective_at: new Date(0).toISOString(),
  config: {
    timezone: "Asia/Shanghai",
    guest: {
      period_kind: "daily",
      period_limit_bytes: 2 * GiB,
      max_file_bytes: 2 * GiB,
      max_share_bytes: 2 * GiB,
      max_files_per_share: 100,
      max_empty_dirs_per_share: 100,
      max_active_shares: 5,
      max_concurrent_upload_batches: 1,
      default_retention_hours: 1,
      retention_options_hours: [1, 6, 24, 72],
      default_max_downloads: 10,
      download_options: [1, 10],
    },
    user: {
      period_kind: "monthly",
      period_limit_bytes: 50 * GiB,
      max_file_bytes: 10 * GiB,
      max_share_bytes: 20 * GiB,
      max_files_per_share: 500,
      max_empty_dirs_per_share: 500,
      max_active_shares: 30,
      max_concurrent_upload_batches: 3,
      default_retention_hours: 168,
      retention_options_hours: [1, 6, 24, 72, 168, 360, 720],
      default_max_downloads: 100,
      download_options: [1, 10, 50, 100, 200, 0],
    },
    receive: {
      enabled: true,
      max_active_requests: 10,
      max_request_bytes: 10 * GiB,
      max_file_bytes: 10 * GiB,
      max_files_per_request: 100,
      default_retention_hours: 168,
      retention_options_hours: [24, 168, 720],
    },
    retention_coupon_hours: 2160,
  },
  technical: {
    max_file_bytes: 10 * GiB,
    max_share_bytes: 50 * GiB,
    max_files_per_share: 500,
    max_empty_dirs_per_share: 500,
    max_retention_hours: 2160,
    max_active_links: 200,
    max_concurrent_upload_batches: 10,
    max_request_bytes: 10 * GiB,
    max_request_files: 100,
  },
};

export function formatPolicyBytes(bytes: number): string {
  const value = bytes / GiB;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}GB`;
}

export function periodLabel(kind: SendQuotaPolicy["period_kind"]): string {
  return kind === "daily" ? "每日" : "每月";
}

export function retentionLabel(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24}天`;
  return `${hours}小时`;
}

export function createHomeFaqs(policy: PublicQuotaPolicy) {
  const { guest, user, receive } = policy.config;
  return [
    {
      question: "不注册也能传文件吗？",
      answer: `可以。游客拥有 ${formatPolicyBytes(guest.period_limit_bytes)} / ${periodLabel(guest.period_kind)}额度，单文件最高 ${formatPolicyBytes(guest.max_file_bytes)}，最多保留 ${guest.max_active_shares} 个活跃分享，每条分享最长 ${retentionLabel(Math.max(...guest.retention_options_hours))}。`,
    },
    {
      question: "登录后有什么不同？",
      answer: `登录用户拥有 ${formatPolicyBytes(user.period_limit_bytes)} / ${periodLabel(user.period_kind)}额度，单文件最高 ${formatPolicyBytes(user.max_file_bytes)}，最多保留 ${user.max_active_shares} 个活跃分享，普通分享最长 ${retentionLabel(Math.max(...user.retention_options_hours))}，并可在工作台集中管理。`,
    },
    {
      question: "文件会保留多久？",
      answer: "创建分享时由发送者选择有效期。到期或主动撤销后，公开链接会失效，系统再按存储清理流程处理关联对象；重要文件仍应保留自己的原始副本。",
    },
    {
      question: "可以让别人把文件发给我吗？",
      answer: receive.enabled
        ? `可以。登录后创建收件链接，对方无需账号即可提交。每条收件链接最多接收 ${formatPolicyBytes(receive.max_request_bytes)}、${receive.max_files_per_request} 个文件，收到的内容会占用创建者账号额度。`
        : "收件链接当前暂停创建；已有链接仍按创建时规则处理，恢复开放后可继续新建。",
    },
    {
      question: "对方需要安装 App 吗？",
      answer: "不需要。对方通过现代浏览器打开链接即可查看文件列表、按浏览器能力预览并下载；部分超大文件或特殊媒体格式可能更适合桌面浏览器。",
    },
    {
      question: "拿呀²适合保存唯一原件吗？",
      answer: "不适合。它是临时传输与收件工具，不是长期网盘或唯一备份。服务会处理上传、预览、兼容性和安全运营所需的信息，也不是端到端加密存储。",
    },
  ];
}

export async function getServerQuotaPolicy(): Promise<PublicQuotaPolicy> {
  const baseUrl = process.env.NYY_API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
  try {
    const response = await fetch(`${baseUrl}/api/v1/policy/current`, { cache: "no-store" });
    if (!response.ok) return DEFAULT_QUOTA_POLICY;
    return await response.json() as PublicQuotaPolicy;
  } catch {
    return DEFAULT_QUOTA_POLICY;
  }
}

export async function getPublicQuotaPolicy(): Promise<PublicQuotaPolicy> {
  try {
    const response = await fetch("/api/v1/policy/current", { cache: "no-store" });
    if (!response.ok) return DEFAULT_QUOTA_POLICY;
    return await response.json() as PublicQuotaPolicy;
  } catch {
    return DEFAULT_QUOTA_POLICY;
  }
}
