interface BrandLogoProps {
  className?: string;
  priority?: boolean;
}

export function BrandLogo({ className = "h-auto w-48", priority = false }: BrandLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.svg?v=2"
      alt="拿呀呀"
      className={className}
      style={{ filter: "drop-shadow(0 0 12px rgba(255,138,61,0.7)) drop-shadow(0 0 30px rgba(255,138,61,0.4)) drop-shadow(0 0 50px rgba(255,138,61,0.2))" }}
      {...(priority ? { fetchPriority: "high" } : {})}
    />
  );
}
