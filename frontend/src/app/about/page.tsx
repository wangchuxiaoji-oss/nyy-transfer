import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES.about;
export const metadata = createSeoMetadata(page);
export default function AboutPage() { return <SeoPage page={page} />; }
