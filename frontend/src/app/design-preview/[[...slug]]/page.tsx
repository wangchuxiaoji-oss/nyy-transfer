import { PreviewApp } from "@/components/design-preview/preview-app";

export default async function DesignPreviewPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return <PreviewApp path={slug.join("/")} />;
}
