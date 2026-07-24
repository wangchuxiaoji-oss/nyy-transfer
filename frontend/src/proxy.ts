import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = new Set([
  "/", "/large-file-transfer", "/no-signup-file-sharing", "/receive-files", "/wechat-large-file",
  "/how-it-works", "/security", "/about", "/contact", "/privacy", "/terms", "/robots.txt", "/sitemap.xml",
]);

const INTERNAL_PREFIXES = [
  "/admin", "/my", "/prototype-preview", "/video-inspect", "/file-icon-preview",
  "/logo-lockup-preview", "/logo-symbol-preview", "/ac3-lab", "/r/", "/tmp/",
];

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const path = request.nextUrl.pathname;
  const internal = INTERNAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
  const likelyPublicShare = !PUBLIC_PATHS.has(path) && !path.startsWith("/_next/") && path.split("/").filter(Boolean).length === 1;
  if (internal || likelyPublicShare) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|patterns/).*)"],
};
