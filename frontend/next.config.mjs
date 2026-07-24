const distDir = process.env.NEXT_DIST_DIR || ".next";
const customTsconfig = distDir === ".next-playwright"
  ? "tsconfig.playwright.json"
  : distDir === ".next-production-a"
    ? "tsconfig.production-a.json"
    : distDir === ".next-production-b"
      ? "tsconfig.production-b.json"
      : "tsconfig.json";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  poweredByHeader: false,
  typescript: { tsconfigPath: customTsconfig },
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    localPatterns: [{ pathname: "/**" }],
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
