import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES["wechat-large-file"];
export const metadata = createSeoMetadata(page);
export default function WechatLargeFilePage() { return <SeoPage page={page} />; }
