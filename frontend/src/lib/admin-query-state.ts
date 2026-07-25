export type AdminTab =
  | "overview"
  | "shares"
  | "reports"
  | "users"
  | "emails"
  | "mailbox"
  | "announcements"
  | "quota"
  | "download"
  | "doubao"
  | "diagnostics";

export type AdminPaginationMode = "cursor" | "page";

export interface AdminQueryState {
  tab: AdminTab;
  q: string;
  status: string;
  sort: string;
  page: number;
  after: string;
  paginationMode: AdminPaginationMode;
  createdFrom: string;
  createdTo: string;
  expiresFrom: string;
  expiresTo: string;
  activityFrom: string;
  activityTo: string;
  minFiles: number | null;
  maxFiles: number | null;
  minBytes: number | null;
  maxBytes: number | null;
  risk: string;
}

export const ADMIN_TAB_KEYS: AdminTab[] = [
  "overview",
  "shares",
  "reports",
  "users",
  "emails",
  "mailbox",
  "announcements",
  "quota",
  "download",
  "doubao",
  "diagnostics",
];

interface SearchParamsLike {
  get(name: string): string | null;
}

function positiveNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function readAdminQueryState(searchParams: SearchParamsLike): AdminQueryState {
  const tabParam = searchParams.get("tab") as AdminTab | null;
  const paginationMode = searchParams.get("pagination_mode");
  return {
    tab: tabParam && ADMIN_TAB_KEYS.includes(tabParam) ? tabParam : "overview",
    q: searchParams.get("q") || "",
    status: searchParams.get("status") || "all",
    sort: searchParams.get("sort") || "created_desc",
    page: Math.max(1, Number(searchParams.get("page")) || 1),
    after: searchParams.get("after") || "",
    paginationMode: paginationMode === "page" ? "page" : "cursor",
    createdFrom: searchParams.get("created_from") || "",
    createdTo: searchParams.get("created_to") || "",
    expiresFrom: searchParams.get("expires_from") || "",
    expiresTo: searchParams.get("expires_to") || "",
    activityFrom: searchParams.get("activity_from") || "",
    activityTo: searchParams.get("activity_to") || "",
    minFiles: positiveNumber(searchParams.get("min_files")),
    maxFiles: positiveNumber(searchParams.get("max_files")),
    minBytes: positiveNumber(searchParams.get("min_bytes")),
    maxBytes: positiveNumber(searchParams.get("max_bytes")),
    risk: searchParams.get("risk") || "all",
  };
}

export function hasPreciseShareFilters(query: AdminQueryState): boolean {
  return Boolean(
    query.q ||
    query.createdFrom ||
    query.createdTo ||
    query.expiresFrom ||
    query.expiresTo ||
    query.activityFrom ||
    query.activityTo ||
    query.minFiles !== null ||
    query.maxFiles !== null ||
    query.minBytes !== null ||
    query.maxBytes !== null ||
    query.risk !== "all"
  );
}

export const ADMIN_QUERY_RESET: Record<string, null> = {
  q: null,
  status: null,
  sort: null,
  page: null,
  after: null,
  pagination_mode: null,
  created_from: null,
  created_to: null,
  expires_from: null,
  expires_to: null,
  activity_from: null,
  activity_to: null,
  min_files: null,
  max_files: null,
  min_bytes: null,
  max_bytes: null,
  risk: null,
};
