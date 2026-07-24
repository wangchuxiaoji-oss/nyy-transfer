import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES["how-it-works"];
export const metadata = createSeoMetadata(page);
export default function HowItWorksPage() { return <SeoPage page={page} />; }
