import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES.security;
export const metadata = createSeoMetadata(page);
export default function SecurityPage() { return <SeoPage page={page} />; }
