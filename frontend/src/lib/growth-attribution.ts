export const GROWTH_ATTRIBUTION_KEY = "nyy_growth_attribution";
const GROWTH_VISITOR_KEY = "nyy_growth_visitor_id";
const REFERRAL_SHARE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export interface GrowthAttribution {
  referralShareCode?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  landingId?: string;
  firstLandingAt: string;
  lastLandingAt: string;
}

export function getGrowthVisitorId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = localStorage.getItem(GROWTH_VISITOR_KEY);
    if (existing && existing.length >= 8 && existing.length <= 64) return existing;
    const visitorId = `visitor-${crypto.randomUUID()}`;
    localStorage.setItem(GROWTH_VISITOR_KEY, visitorId);
    return visitorId;
  } catch {
    return `visitor-${crypto.randomUUID()}`;
  }
}

function clean(value: string | null, maxLength = 128): string | undefined {
  const normalized = value?.trim().slice(0, maxLength);
  return normalized || undefined;
}

function cleanReferralShareCode(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && REFERRAL_SHARE_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

export function readGrowthAttribution(): GrowthAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(GROWTH_ATTRIBUTION_KEY) || "null");
    return value && typeof value === "object" ? value as GrowthAttribution : null;
  } catch {
    return null;
  }
}

export function captureGrowthAttribution(url: URL): GrowthAttribution | null {
  if (typeof window === "undefined") return null;
  const params = url.searchParams;
  const incoming = {
    referralShareCode: cleanReferralShareCode(params.get("ref_share")),
    utmSource: clean(params.get("utm_source")),
    utmMedium: clean(params.get("utm_medium")),
    utmCampaign: clean(params.get("utm_campaign")),
    utmTerm: clean(params.get("utm_term")),
    utmContent: clean(params.get("utm_content")),
  };
  if (!Object.values(incoming).some(Boolean)) {
    const previous = readGrowthAttribution();
    if (previous) return previous;
    const now = new Date().toISOString();
    const initial = { firstLandingAt: now, lastLandingAt: now } satisfies GrowthAttribution;
    try {
      localStorage.setItem(GROWTH_ATTRIBUTION_KEY, JSON.stringify(initial));
    } catch {}
    return initial;
  }

  const now = new Date().toISOString();
  const previous = readGrowthAttribution();
  const next: GrowthAttribution = {
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => Boolean(value))),
    ...previous,
    firstLandingAt: previous?.firstLandingAt || now,
    lastLandingAt: now,
  };
  try {
    localStorage.setItem(GROWTH_ATTRIBUTION_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function updateGrowthLandingId(landingId: string): void {
  const attribution = readGrowthAttribution();
  if (!attribution || typeof window === "undefined") return;
  try {
    localStorage.setItem(GROWTH_ATTRIBUTION_KEY, JSON.stringify({ ...attribution, landingId }));
  } catch {}
}

export function getReferralShareCode(): string | undefined {
  return cleanReferralShareCode(readGrowthAttribution()?.referralShareCode);
}

export function clearGrowthAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(GROWTH_ATTRIBUTION_KEY);
  } catch {}
}
