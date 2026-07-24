import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES["large-file-transfer"];
export const metadata = createSeoMetadata(page);
export default function LargeFileTransferPage() { return <SeoPage page={page} />; }
