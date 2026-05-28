export class HttpStatusError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(`${status}：${message}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

interface HttpErrorOptions {
  fallback?: string;
  statusMessages?: Partial<Record<number, string>>;
}

interface ValidationErrorItem {
  msg?: string;
}

const STATUS_MESSAGES: Record<number, string> = {
  0: "网络连接失败，请检查网络或确认前后端服务已启动",
  400: "请求参数不正确",
  401: "请先登录，或重新登录后再试",
  403: "没有权限执行该操作",
  404: "资源不存在或已被删除",
  409: "当前操作与已有数据冲突",
  410: "资源已过期或不可用",
  422: "请求参数格式不正确",
  429: "操作过于频繁或额度已用完",
  500: "服务器内部错误，请稍后重试",
  502: "上游服务暂时不可用，请稍后重试",
  503: "服务暂时不可用，请稍后重试",
};

const SERVER_DETAIL_MESSAGES: Record<string, string> = {
  "Upload service unavailable": "上传服务暂时不可用，请稍后重试",
  "Redis unavailable": "缓存服务暂时不可用，请稍后重试",
  "Invalid or expired commit_token": "上传会话已过期，请重新选择文件上传",
  "store_uri mismatch": "上传文件校验失败，请重新上传",
  "Commit failed": "上传确认失败，请稍后重试",
  "Share not found": "分享不存在或已被删除",
  "Share expired": "分享已过期",
  "Download limit reached": "下载次数已用完",
  "Download service error": "下载服务暂时不可用，请稍后重试",
  "Share has no password": "该分享未设置提取码",
  "Wrong password": "提取码错误",
  "No files in share": "分享中没有可下载文件",
  "No files": "分享中没有可下载文件",
  "Password required. Use POST /verify first.": "该分享需要提取码",
  "Verify failed": "验证失败，请稍后重试",
  "Download failed": "获取下载链接失败",
  "Report failed": "举报提交失败",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function statusMessage(status: number, options: HttpErrorOptions): string {
  return options.statusMessages?.[status] || options.fallback || STATUS_MESSAGES[status] || "请求失败，请稍后重试";
}

function translateValidationMessage(message: string): string {
  if (!message) return "参数格式不正确";
  if (/[^\x00-\x7F]/.test(message)) return message;

  const lower = message.toLowerCase();
  if (lower.includes("field required")) return "缺少必填字段";
  if (lower.includes("string should have at least")) return "文本长度不足";
  if (lower.includes("string should have at most")) return "文本过长";
  if (lower.includes("should match pattern")) return "格式不正确";
  if (lower.includes("greater than or equal")) return "数值过小";
  if (lower.includes("less than or equal")) return "数值过大";
  if (lower.includes("valid integer")) return "需要填写有效数字";
  return "参数格式不正确";
}

function translateServerDetail(detail: string): string | null {
  const text = detail.trim();
  if (!text) return null;
  if (/[^\x00-\x7F]/.test(text)) return text;

  const quotaMatch = text.match(/^(Guest|User) quota exceeded: (\d+)\/(\d+) bytes used$/);
  if (quotaMatch) {
    const actor = quotaMatch[1] === "Guest" ? "游客" : "账号";
    return `${actor}上传额度不足（已用 ${formatBytes(Number(quotaMatch[2]))} / 上限 ${formatBytes(Number(quotaMatch[3]))}）`;
  }

  const activeShareMatch = text.match(/^Active share limit reached \((\d+)\/(\d+)\)/);
  if (activeShareMatch) {
    return `活跃分享数量已达上限（${activeShareMatch[1]}/${activeShareMatch[2]}），请先撤销已有分享`;
  }

  return SERVER_DETAIL_MESSAGES[text] || null;
}

function detailToMessage(detail: unknown, status: number, options: HttpErrorOptions): string {
  if (typeof detail === "string") {
    return translateServerDetail(detail) || statusMessage(status, options);
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => translateValidationMessage((item as ValidationErrorItem)?.msg || ""))
      .filter(Boolean);
    const unique = Array.from(new Set(messages));
    return unique.length > 0 ? `请求参数不正确：${unique.join("；")}` : statusMessage(status, options);
  }

  return statusMessage(status, options);
}

async function readResponseBody(res: Response): Promise<unknown> {
  try {
    const body = await res.clone().json();
    if (body && typeof body === "object" && "detail" in body) return (body as { detail: unknown }).detail;
    if (body && typeof body === "object" && "message" in body) return (body as { message: unknown }).message;
    return body;
  } catch {
    return res.text().catch(() => "");
  }
}

export async function createHttpError(res: Response, options: HttpErrorOptions = {}): Promise<HttpStatusError> {
  const detail = await readResponseBody(res);
  return new HttpStatusError(res.status, detailToMessage(detail, res.status, options));
}

export function isHttpStatusError(error: unknown, status: number): boolean {
  return error instanceof HttpStatusError && error.status === status;
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function formatXhrStatusError(status: number, fallback = "请求失败"): string {
  return `${status}：${STATUS_MESSAGES[status] || fallback}`;
}

export function getErrorMessage(error: unknown, fallback = "操作失败"): string {
  if (error instanceof HttpStatusError) return error.message;
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") return formatXhrStatusError(0, fallback);
    return error.message || fallback;
  }
  return fallback;
}
