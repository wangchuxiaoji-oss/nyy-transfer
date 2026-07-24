import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-07-22T00:00:00.000Z");
  const pages = [
    ["", 1, "weekly"],
    ["large-file-transfer", 0.9, "monthly"],
    ["no-signup-file-sharing", 0.9, "monthly"],
    ["receive-files", 0.9, "monthly"],
    ["wechat-large-file", 0.85, "monthly"],
    ["how-it-works", 0.8, "monthly"],
    ["security", 0.8, "monthly"],
    ["about", 0.7, "yearly"],
    ["contact", 0.6, "yearly"],
    ["privacy", 0.5, "yearly"],
    ["terms", 0.5, "yearly"],
  ] as const;
  return pages.map(([path, priority, changeFrequency]) => ({
    url: path ? `https://nyy.app/${path}` : "https://nyy.app/",
    lastModified,
    changeFrequency,
    priority,
  }));
}
