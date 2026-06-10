import Link from "next/link";
import { BRAND_NAME } from "@/lib/copy";

interface BrandLogoProps {
  className?: string;
  priority?: boolean;
  src?: string;
  glow?: boolean;
  href?: string;
}

export function BrandLogo({ className = "h-auto w-48", priority = false, src = "/logo-lockup-scheme-02.png?v=20260608-lockup-02", glow = false, href }: BrandLogoProps) {
  const glowStyle = glow
    ? { filter: "drop-shadow(0 0 12px rgba(255,138,61,0.7)) drop-shadow(0 0 30px rgba(255,138,61,0.4)) drop-shadow(0 0 50px rgba(255,138,61,0.2))" }
    : undefined;

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={BRAND_NAME}
      className={className}
      style={glowStyle}
      {...(priority ? { fetchPriority: "high" } : {})}
    />
  );

  if (href) {
    return (
      <Link href={href} aria-label={`返回${BRAND_NAME}首页`} className="inline-flex w-fit shrink-0 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nyy-400 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent">
        {image}
      </Link>
    );
  }

  return image;
}
