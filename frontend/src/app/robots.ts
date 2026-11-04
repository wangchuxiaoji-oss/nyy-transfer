import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/", "/admin", "/my", "/r/", "/prototype-preview", "/video-inspect",
          "/file-icon-preview", "/logo-lockup-preview", "/logo-symbol-preview", "/ac3-lab", "/design-preview", "/tmp/",
        ],
      },
    ],
    sitemap: "https://nyy.app/sitemap.xml",
  };
}
