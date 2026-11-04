import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, FileArchive, FileImage, FileSpreadsheet, FileText, Film, Folder, LockKeyhole, ShieldCheck } from "lucide-react";
import { BrandLockup, type LogoCandidate } from "@/components/design-preview/preview-logo";

export function ProductHeader({ candidate, action = "登录", compact = false }: { candidate: LogoCandidate; action?: string; compact?: boolean }) {
  return (
    <header className="dp-product-header">
      <BrandLockup candidate={candidate} compact={compact} />
      <nav className="dp-product-nav" aria-label="预览页面导航">
        <a href="#dp-main">传文件</a>
        <a href="#dp-main">收文件</a>
        <a href="#dp-more">安全</a>
      </nav>
      <button className="dp-button dp-button-secondary" type="button">{action}</button>
    </header>
  );
}

export function PreviewFooter({ candidate }: { candidate: LogoCandidate }) {
  return (
    <footer className="dp-product-footer">
      <BrandLockup candidate={candidate} />
      <p>独立维护的文件交付与收件工具</p>
      <nav aria-label="页脚导航"><a href="#dp-more">安全</a><a href="#dp-more">隐私</a><a href="#dp-more">联系</a></nav>
    </footer>
  );
}

export function SectionHeading({ eyebrow, title, description, align = "left" }: { eyebrow: string; title: string; description?: string; align?: "left" | "center" }) {
  return (
    <div className={`dp-section-heading dp-align-${align}`}>
      <p className="dp-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warning" | "error" | "info"; children: ReactNode }) {
  return <span className={`dp-badge dp-badge-${tone}`}>{children}</span>;
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="dp-progress-wrap">
      {label && <div className="dp-progress-label"><span>{label}</span><strong>{value}%</strong></div>}
      <div className="dp-progress" aria-label={`${label ?? "进度"} ${value}%`}><span style={{ transform: `scaleX(${value / 100})` }} /></div>
    </div>
  );
}

type FileKind = "image" | "video" | "document" | "sheet" | "archive" | "folder";

export function FileGlyph({ kind }: { kind: FileKind }) {
  const Icon = kind === "image" ? FileImage : kind === "video" ? Film : kind === "sheet" ? FileSpreadsheet : kind === "archive" ? FileArchive : kind === "folder" ? Folder : FileText;
  return <span className={`dp-file-glyph dp-file-${kind}`}><Icon aria-hidden="true" /></span>;
}

export function FileRow({ name, meta, kind = "document", status, action = "查看" }: { name: string; meta: string; kind?: FileKind; status?: ReactNode; action?: string }) {
  return (
    <div className="dp-file-row">
      <FileGlyph kind={kind} />
      <div className="dp-file-copy"><strong title={name}>{name}</strong><span>{meta}</span></div>
      {status && <div className="dp-file-status">{status}</div>}
      <button className="dp-button dp-button-ghost dp-button-small" type="button">{action}</button>
    </div>
  );
}

export function StateMessage({ tone, title, description, action }: { tone: "success" | "warning" | "error" | "locked"; title: string; description: string; action?: string }) {
  const Icon = tone === "success" ? Check : tone === "error" ? AlertTriangle : tone === "locked" ? LockKeyhole : ShieldCheck;
  return (
    <section className={`dp-state-message dp-state-${tone}`}>
      <span className="dp-state-icon"><Icon aria-hidden="true" /></span>
      <p className="dp-eyebrow">{tone === "success" ? "已完成" : tone === "locked" ? "访问保护" : "状态提示"}</p>
      <h1>{title}</h1>
      <p>{description}</p>
      {action && <button className="dp-button dp-button-primary" type="button">{action}<ArrowRight aria-hidden="true" /></button>}
    </section>
  );
}

export function SkeletonBlock({ rows = 4 }: { rows?: number }) {
  return <div className="dp-skeleton" aria-label="加载中">{Array.from({ length: rows }, (_, index) => <span key={index} style={{ width: `${92 - index * 8}%` }} />)}</div>;
}

export function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="dp-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export function InlineNotice({ tone = "info", title, children }: { tone?: "info" | "warning" | "error" | "success"; title: string; children: ReactNode }) {
  return <div className={`dp-inline-notice dp-notice-${tone}`}><strong>{title}</strong><span>{children}</span></div>;
}
