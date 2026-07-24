import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES["receive-files"];
export const metadata = createSeoMetadata(page);
export default function ReceiveFilesPage() { return <SeoPage page={page} />; }
