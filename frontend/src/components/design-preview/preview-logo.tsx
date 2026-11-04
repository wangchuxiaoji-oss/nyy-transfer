import type { CSSProperties, ReactNode } from "react";

export const LOGO_CANDIDATES = [
  { value: "a", group: "几何块交接", name: "软块接力", description: "两块圆角载体在中点完成递交，轮廓稳定、动作最直接。" },
  { value: "b", group: "几何块交接", name: "交叠卡片", description: "两张文件卡片错位相接，中间交叠区成为品牌记忆点。" },
  { value: "c", group: "几何块交接", name: "双端递出", description: "左右两端共同托住文件块，更突出发送与接收的双向关系。" },
  { value: "d", group: "连续线交接", name: "一笔递交", description: "单条圆润路径从递出到接住，轻盈、连续且适合动效延展。" },
  { value: "e", group: "连续线交接", name: "回环接力", description: "回环路径围绕交接点流动，强调重复使用和顺畅传递。" },
  { value: "f", group: "连续线交接", name: "双弧汇合", description: "两条独立弧线在中心汇合，结构平衡且保留开放感。" },
  { value: "g", group: "负形交接", name: "文件留白", description: "两块实体之间留出文件形负空间，符号紧凑、品牌感更强。" },
  { value: "h", group: "负形交接", name: "纽带留白", description: "四个圆角面围出连接纽带，适合应用图标和印章场景。" },
  { value: "i", group: "负形交接", name: "入口留白", description: "左右入口围出向前移动的空隙，表达开放与领取。" },
  { value: "j", group: "抽象双手", name: "双掌承托", description: "两道掌形曲线共同托举文件，不画具体手指，亲和但不幼稚。" },
  { value: "k", group: "抽象双手", name: "合掌递交", description: "两侧手势向中心靠拢，交接动作明确且整体更集中。" },
  { value: "l", group: "抽象双手", name: "开放托举", description: "开放双掌与上移文件形成轻微上扬姿态，服务感最强。" },
] as const;

export type LogoCandidate = (typeof LOGO_CANDIDATES)[number]["value"];

export const DEFAULT_LOGO_CANDIDATE: LogoCandidate = "a";

export function isLogoCandidate(value: string | null): value is LogoCandidate {
  return LOGO_CANDIDATES.some((candidate) => candidate.value === value);
}

interface BrandSymbolProps {
  candidate?: LogoCandidate;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function BrandSymbol({ candidate = DEFAULT_LOGO_CANDIDATE, className = "", style, title = "拿呀²品牌符号候选" }: BrandSymbolProps) {
  return (
    <svg className={className} style={style} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={`${title} ${candidate.toUpperCase()}`}>
      {candidate === "a" && <><rect x="3.5" y="16" width="11.5" height="9" rx="4.5" stroke="currentColor" strokeWidth="2.2" /><rect x="17" y="7" width="11.5" height="9" rx="4.5" stroke="currentColor" strokeWidth="2.2" /><rect x="12.5" y="12" width="7" height="8" rx="2.5" fill="var(--dp-logo-accent)" /><path d="M10 20.5h3M19 11.5h3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></>}
      {candidate === "b" && <><rect x="4" y="8" width="15" height="16" rx="5" stroke="currentColor" strokeWidth="2.2" /><rect x="13" y="8" width="15" height="16" rx="5" stroke="var(--dp-logo-accent)" strokeWidth="2.2" /><path d="M13 12.5c2.8 0 5.2 1.6 6 4-1 2.4-3.2 4-6 4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></>}
      {candidate === "c" && <><path d="M3.5 12.5c0-2.5 2-4.5 4.5-4.5h3.5a4.5 4.5 0 0 1 0 9H8A4.5 4.5 0 0 0 3.5 21.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><path d="M28.5 19.5c0 2.5-2 4.5-4.5 4.5h-3.5a4.5 4.5 0 0 1 0-9H24a4.5 4.5 0 0 0 4.5-4.5" stroke="var(--dp-logo-accent)" strokeWidth="2.2" strokeLinecap="round" /><rect x="12.5" y="12.5" width="7" height="7" rx="2.2" fill="currentColor" /></>}
      {candidate === "d" && <><path d="M3 21c4.5 0 5.8-6.5 10.1-6.5h5.8C23.2 14.5 24.5 8 29 8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /><path d="M3 16.5V21h4.5M24.5 8H29v4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><rect x="13" y="11" width="6" height="7" rx="2" fill="var(--dp-logo-accent)" /></>}
      {candidate === "e" && <><path d="M5 20.5c0-6.5 6.8-11 11-5 4.2 6 11 1.5 11-5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" /><path d="M5 11.5c0 6.5 6.8 11 11 5 4.2-6 11-1.5 11 5" stroke="var(--dp-logo-accent)" strokeWidth="2.3" strokeLinecap="round" /><circle cx="16" cy="16" r="2.8" fill="currentColor" /></>}
      {candidate === "f" && <><path d="M3.5 22.5c3.5-7 7.2-10.5 12.5-10.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /><path d="M28.5 9.5C25 16.5 21.3 20 16 20" stroke="var(--dp-logo-accent)" strokeWidth="2.5" strokeLinecap="round" /><path d="m12.8 8.8 3.5 3.2-3.5 3.2M19.2 16.8 15.7 20l3.5 3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>}
      {candidate === "g" && <><path d="M3 7.5A4.5 4.5 0 0 1 7.5 3H14v8.5c0 1.4-1.1 2.5-2.5 2.5H3V7.5Z" fill="currentColor" /><path d="M29 24.5a4.5 4.5 0 0 1-4.5 4.5H18v-8.5c0-1.4 1.1-2.5 2.5-2.5H29v6.5Z" fill="var(--dp-logo-accent)" /><path d="M8 19h5v-5M24 13h-5v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}
      {candidate === "h" && <><path d="M4 12V8a4 4 0 0 1 4-4h4M20 4h4a4 4 0 0 1 4 4v4M28 20v4a4 4 0 0 1-4 4h-4M12 28H8a4 4 0 0 1-4-4v-4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><path d="M11 16h10M17.5 12.5 21 16l-3.5 3.5" stroke="var(--dp-logo-accent)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></>}
      {candidate === "i" && <><path d="M3 9a6 6 0 0 1 6-6h8v7a6 6 0 0 1-6 6H3V9Z" fill="currentColor" /><path d="M29 23a6 6 0 0 1-6 6h-8v-7a6 6 0 0 1 6-6h8v7Z" fill="var(--dp-logo-accent)" /><path d="M11 21h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><circle cx="11" cy="21" r="2" fill="currentColor" /><circle cx="21" cy="21" r="2" fill="currentColor" /></>}
      {candidate === "j" && <><rect x="12" y="5" width="8" height="9" rx="2.5" fill="var(--dp-logo-accent)" /><path d="M3.5 17.5c3.5 0 5.5 1 7.5 4.5 1-4.5 2.5-6.5 5-6.5s4 2 5 6.5c2-3.5 4-4.5 7.5-4.5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M6 22.5c3 4 6.2 5.5 10 5.5s7-1.5 10-5.5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" /></>}
      {candidate === "k" && <><path d="M3.5 9.5c5 0 8 2.5 8 7.5v7.5c-4.7 0-8-3.3-8-8V9.5Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="M28.5 9.5c-5 0-8 2.5-8 7.5v7.5c4.7 0 8-3.3 8-8V9.5Z" stroke="var(--dp-logo-accent)" strokeWidth="2.2" strokeLinejoin="round" /><rect x="12.5" y="7" width="7" height="9" rx="2.5" fill="currentColor" /></>}
      {candidate === "l" && <><path d="M4 17c3.4 0 5.6 1.5 7.2 4.5 1.3-2 2.8-3 4.8-3s3.5 1 4.8 3C22.4 18.5 24.6 17 28 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /><path d="M6 22c3.1 4.2 6.4 6 10 6s6.9-1.8 10-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /><rect x="12" y="5" width="8" height="9" rx="2.5" fill="var(--dp-logo-accent)" /><path d="M16 16.5v-2.5" stroke="var(--dp-logo-accent)" strokeWidth="2.2" strokeLinecap="round" /></>}
    </svg>
  );
}

interface BrandLockupProps {
  candidate?: LogoCandidate;
  compact?: boolean;
  inverse?: boolean;
  className?: string;
}

export function BrandLockup({ candidate = DEFAULT_LOGO_CANDIDATE, compact = false, inverse = false, className = "" }: BrandLockupProps) {
  return (
    <span className={`dp-brand-lockup ${inverse ? "dp-brand-lockup-inverse" : ""} ${className}`}>
      <BrandSymbol candidate={candidate} className="dp-brand-symbol" />
      {!compact && (
        <span className="dp-brand-type">
          <span className="dp-brand-name"><span>拿</span><span>呀</span><sup>2</sup></span>
          <span className="dp-brand-domain">nyy.app</span>
        </span>
      )}
    </span>
  );
}

export function LogoApplication({ children, tone = "light" }: { children: ReactNode; tone?: "light" | "dark" | "paper" }) {
  return <div className={`dp-logo-application dp-logo-application-${tone}`}>{children}</div>;
}
