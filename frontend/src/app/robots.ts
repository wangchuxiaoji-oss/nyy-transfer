import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin/", "/my/"],
      },
    ],
    sitemap: "https://nyy.app/sitemap.xml",
  };
}
