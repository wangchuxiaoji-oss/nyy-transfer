import { AdminScreen, WorkspaceScreen } from "@/components/design-preview/admin-screens";
import { ContentScreen } from "@/components/design-preview/content-screens";
import { BrandScreen, HomeScreen, OverviewScreen, RequestScreen, ShareScreen } from "@/components/design-preview/core-screens";
import { type LogoCandidate } from "@/components/design-preview/preview-logo";

export interface PreviewScreenProps {
  path: string;
  state: string;
  candidate: LogoCandidate;
}

const ADMIN_MODULES = [
  "overview",
  "shares",
  "reports",
  "users",
  "emails",
  "mailbox",
  "announcements",
  "quota",
  "download",
  "doubao",
  "diagnostics",
] as const;

type AdminModule = (typeof ADMIN_MODULES)[number];

function isAdminModule(pageId: string): pageId is AdminModule {
  return (ADMIN_MODULES as readonly string[]).includes(pageId);
}

export function PreviewScreen({ path, state, candidate }: PreviewScreenProps) {
  const [section = "overview", pageId = ""] = path.split("/").filter(Boolean);

  if (section === "overview") return <OverviewScreen candidate={candidate} />;
  if (section === "brand") return <BrandScreen state={state} candidate={candidate} />;

  if (section === "core") {
    if (pageId === "home") return <HomeScreen state={state} candidate={candidate} />;
    if (pageId === "share") return <ShareScreen state={state} candidate={candidate} />;
    if (pageId === "request") return <RequestScreen state={state} candidate={candidate} />;
  }

  if (section === "workspace" && pageId === "my") {
    return <WorkspaceScreen state={state} candidate={candidate} />;
  }

  if (section === "admin") {
    if (pageId === "share-preview") return <ShareScreen state={state} candidate={candidate} admin />;
    if (isAdminModule(pageId)) return <AdminScreen module={pageId} state={state} candidate={candidate} />;
  }

  if (section === "content" && pageId) {
    return <ContentScreen pageId={pageId} state={state} candidate={candidate} />;
  }

  return <ContentScreen pageId="not-found" state="ready" candidate={candidate} />;
}
