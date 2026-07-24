import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES.contact;
export const metadata = createSeoMetadata(page);
export default function ContactPage() { return <SeoPage page={page} />; }
