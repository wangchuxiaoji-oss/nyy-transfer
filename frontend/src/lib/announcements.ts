import { API_BASE } from "./auth";
import { createHttpError } from "./errors";

export type AnnouncementCategory = "release" | "maintenance" | "incident";
export type AnnouncementPriority = "normal" | "important" | "critical";
export type AnnouncementState =
  | "released"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "investigating"
  | "monitoring"
  | "resolved"
  | "cancelled";

export interface SystemAnnouncement {
  id: string;
  notice_id: string;
  version: string;
  category: AnnouncementCategory;
  state: AnnouncementState;
  priority: AnnouncementPriority;
  title: string;
  summary: string;
  details: string[];
  revision: number;
  started_at: string | null;
  completed_at: string | null;
  visible_until: string | null;
  published_at: string;
}

export interface AnnouncementListResponse {
  items: SystemAnnouncement[];
  has_more: boolean;
  next_offset: number | null;
}

export async function getSystemAnnouncements({
  limit = 20,
  offset = 0,
  activeOnly = false,
}: {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
} = {}): Promise<AnnouncementListResponse> {
  const search = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (activeOnly) search.set("active_only", "true");
  const response = await fetch(`${API_BASE}/api/v1/system/announcements?${search.toString()}`);
  if (!response.ok) throw await createHttpError(response, { fallback: "更新记录加载失败" });
  return response.json();
}

export const ANNOUNCEMENT_CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  release: "功能更新",
  maintenance: "系统维护",
  incident: "服务事件",
};

export const ANNOUNCEMENT_STATE_LABELS: Record<AnnouncementState, string> = {
  released: "已上线",
  scheduled: "已安排",
  in_progress: "进行中",
  completed: "已完成",
  investigating: "排查中",
  monitoring: "观察中",
  resolved: "已解决",
  cancelled: "已取消",
};

export function announcementTimestamp(item: SystemAnnouncement): string {
  return item.completed_at || item.published_at;
}

export function formatAnnouncementTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function isPersistentSystemStatus(item: SystemAnnouncement): boolean {
  return (
    (item.category === "maintenance" && item.state === "in_progress") ||
    (item.category === "incident" && ["investigating", "monitoring"].includes(item.state))
  );
}
