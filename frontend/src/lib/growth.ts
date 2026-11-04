import { authFetch, completeGuestIdMigration, getGuestId } from "./auth";
import { captureGrowthAttribution, getGrowthVisitorId, updateGrowthLandingId, type GrowthAttribution } from "./growth-attribution";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export interface RetentionCoupon {
  id: string;
  duration_days: number;
  status: "available" | "used" | "expired" | string;
  expires_at: string | null;
  issued_at?: string | null;
}

export interface InvitationProgress {
  invited_count: number;
  target_count: number;
  progress_percent: number;
  next_reward?: string | null;
}

export interface GrowthMe {
  retention_coupons: RetentionCoupon[];
  invitation: InvitationProgress;
}

interface RetentionCouponWire extends Partial<RetentionCoupon> {
  retention_coupon_id?: string;
  retention_days?: number;
  target_ttl_days?: number;
}

interface GrowthMeWire {
  retention_coupons?: RetentionCouponWire[];
  available_retention_coupons?: RetentionCouponWire[];
  available_coupons?: RetentionCouponWire[];
  invitation?: Partial<InvitationProgress>;
  referral_progress?: Partial<InvitationProgress>;
  referrals?: { pending?: number; qualified?: number };
}

function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function growthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const guestId = getGuestId();
  if (guestId) headers["X-NYY-Guest-ID"] = guestId;
  return headers;
}

async function growthRequest(path: string, init?: RequestInit, authenticated = false): Promise<Response> {
  const request = authenticated ? authFetch : fetch;
  const primary = await request(`${API_BASE}/api/v1/growth${path}`, init);
  completeGuestIdMigration(primary);
  if (primary.status !== 404 && primary.status !== 405) return primary;
  const fallback = await request(`${API_BASE}/growth${path}`, init);
  completeGuestIdMigration(fallback);
  return fallback;
}

export async function recordGrowthLanding(url: URL): Promise<void> {
  const attribution = captureGrowthAttribution(url);
  if (!attribution) return;
  const dedupeKey = `nyy_growth_landing:${url.search}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) return;
    sessionStorage.setItem(dedupeKey, "1");
  } catch {}

  const response = await growthRequest("/landing", {
    method: "POST",
    headers: growthHeaders(),
    body: JSON.stringify({
      request_id: requestId("landing"),
      visitor_id: getGrowthVisitorId(),
      utm_source: attribution.utmSource,
      utm_medium: attribution.utmMedium,
      utm_campaign: attribution.utmCampaign,
      utm_term: attribution.utmTerm,
      utm_content: attribution.utmContent,
      landing_path: `${url.pathname}${url.search}`.slice(0, 1024),
      referrer: document.referrer || undefined,
    }),
    keepalive: true,
  });
  if (!response.ok) return;
  const data = await response.json().catch(() => null) as { landing_id?: string; id?: string } | null;
  const landingId = data?.landing_id || data?.id;
  if (landingId) updateGrowthLandingId(landingId);
}

export async function recordViralClick(shareCode: string): Promise<void> {
  const attribution = captureGrowthAttribution(new URL(window.location.href));
  const payload = JSON.stringify({
    share_code: shareCode,
    request_id: requestId("viral"),
    visitor_id: getGrowthVisitorId(),
    utm_source: attribution?.utmSource,
    utm_medium: attribution?.utmMedium,
    utm_campaign: attribution?.utmCampaign,
    utm_term: attribution?.utmTerm,
    utm_content: attribution?.utmContent,
    referrer: document.referrer || undefined,
  });
  const response = await fetch(`${API_BASE}/api/v1/growth/viral-click`, {
    method: "POST",
    headers: growthHeaders(),
    body: payload,
    keepalive: true,
  });
  completeGuestIdMigration(response);
  if (response.status !== 404 && response.status !== 405) return;
  const fallback = await fetch(`${API_BASE}/growth/viral-click`, {
    method: "POST",
    headers: growthHeaders(),
    body: payload,
    keepalive: true,
  });
  completeGuestIdMigration(fallback);
}

export async function getGrowthMe(): Promise<GrowthMe> {
  const response = await growthRequest("/me", undefined, true);
  if (!response.ok) throw new Error("增长权益暂不可用");
  const data = await response.json() as GrowthMeWire;
  const availableOnly = !data.retention_coupons && Boolean(data.available_retention_coupons || data.available_coupons);
  const coupons = (data.retention_coupons || data.available_retention_coupons || data.available_coupons || []).flatMap((coupon) => {
    const id = coupon.id || coupon.retention_coupon_id;
    if (!id) return [];
    return [{
      id,
      duration_days: Number(coupon.duration_days || coupon.retention_days || coupon.target_ttl_days || 90),
      status: coupon.status || (availableOnly ? "available" : "unknown"),
      expires_at: coupon.expires_at || null,
      issued_at: coupon.issued_at || null,
    } satisfies RetentionCoupon];
  });
  const progress = data.invitation || data.referral_progress || {};
  const invitedCount = Number(progress.invited_count ?? data.referrals?.qualified ?? 0);
  const pendingCount = Number(data.referrals?.pending || 0);
  const configuredTarget = Number(progress.target_count);
  const targetCount = Number.isFinite(configuredTarget) && configuredTarget > 0
    ? Math.max(invitedCount, configuredTarget)
    : Math.max(1, invitedCount + 1);
  return {
    retention_coupons: coupons,
    invitation: {
      invited_count: invitedCount,
      target_count: targetCount,
      progress_percent: Number.isFinite(progress.progress_percent)
        ? Math.max(0, Math.min(100, Number(progress.progress_percent)))
        : Math.min(100, (invitedCount / targetCount) * 100),
      next_reward: progress.next_reward || (pendingCount > 0 ? `${pendingCount} 位邀请正在等待真实第三方取链` : "每个合格邀请，双方各得 1 张 90 天分享券"),
    },
  };
}

export function getAvailableRetentionCoupons(growth: GrowthMe | null): RetentionCoupon[] {
  return (growth?.retention_coupons || []).filter((coupon) => coupon.status === "available");
}

export type { GrowthAttribution };
