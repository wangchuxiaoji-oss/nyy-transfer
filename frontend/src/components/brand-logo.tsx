import { BRAND_NAME } from "@/lib/copy";

interface BrandLogoProps {
  className?: string;
  priority?: boolean;
  src?: string;
  glow?: boolean;
}

export function BrandLogo({ className = "h-auto w-48", priority = false, src = "/logo-lockup-scheme-02.png?v=20260608-lockup-02", glow = false }: BrandLogoProps) {
  const glowStyle = glow
    ? { filter: "drop-shadow(0 0 12px rgba(255,138,61,0.7)) drop-shadow(0 0 30px rgba(255,138,61,0.4)) drop-shadow(0 0 50px rgba(255,138,61,0.2))" }
    : undefined;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={BRAND_NAME}
      className={className}
      style={glowStyle}
      {...(priority ? { fetchPriority: "high" } : {})}
    />
  );
}
