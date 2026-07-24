import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ToastProvider } from "@/components/toast-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { GrowthTracker } from "@/components/growth-tracker";
import { BRAND_NAME, SEO_DESCRIPTION, SEO_KEYWORDS, SEO_TITLE } from "@/lib/copy";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  applicationName: BRAND_NAME,
  title: SEO_TITLE,
  description: SEO_DESCRIPTION,
  keywords: SEO_KEYWORDS,
  metadataBase: new URL("https://nyy.app"),
  alternates: {
    canonical: "/",
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    other: {
      "baidu-site-verification": "codeva-X46dCl44SR",
    },
  },
  openGraph: {
    type: "website",
    siteName: BRAND_NAME,
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    url: "https://nyy.app",
    locale: "zh_CN",
    images: [{ url: "https://nyy.app/logo-home-preview.png", width: 1200, height: 630, alt: `${BRAND_NAME}文件传输工具` }],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ["https://nyy.app/logo-home-preview.png"],
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-16.png?v=20260608-symbol-transparent", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png?v=20260608-symbol-transparent", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png?v=20260608-symbol-transparent", sizes: "192x192", type: "image/png" },
    ],
    shortcut: [{ url: "/icons/favicon-32.png?v=20260608-symbol-transparent", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png?v=20260608-symbol-transparent", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: BRAND_NAME,
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFF4EB" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0418" },
  ],
  colorScheme: "light dark",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("nyy-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);var r=document.documentElement;if(d){r.classList.add("dark");r.setAttribute("data-theme","dark")}else{r.setAttribute("data-theme","light")}}catch(e){}})()`,
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: BRAND_NAME,
                url: "https://nyy.app",
                logo: "https://nyy.app/icons/icon-192.png",
                email: "admin@nyy.app",
              },
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: BRAND_NAME,
                url: "https://nyy.app",
                inLanguage: "zh-CN",
                description: SEO_DESCRIPTION,
              },
              {
                "@context": "https://schema.org",
                "@type": "SoftwareApplication",
                name: BRAND_NAME,
                url: "https://nyy.app",
                description: SEO_DESCRIPTION,
                applicationCategory: "UtilitiesApplication",
                operatingSystem: "Web",
                inLanguage: "zh-CN",
                offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
              },
            ]),
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <ThemeProvider>
          <GrowthTracker />
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
