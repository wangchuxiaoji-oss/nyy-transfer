import { SeoPage, createSeoMetadata } from "@/components/seo-page";
import { SEO_PAGES } from "@/lib/seo-pages";

const page = SEO_PAGES["no-signup-file-sharing"];
export const metadata = createSeoMetadata(page);
export default function NoSignupFileSharingPage() { return <SeoPage page={page} />; }
