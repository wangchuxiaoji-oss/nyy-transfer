import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "plyr/dist/plyr.css";
import { ToastProvider } from "@/components/toast-provider";
import { ThemeProvider } from "@/components/theme-provider";

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
  applicationName: "拿呀呀",
  title: "拿呀呀 nyy.app - 想传文件？拿呀呀",
  description: "简单、快速、免注册的文件分享服务。单文件最大 1GB，浏览器直传。",
  keywords: ["文件分享", "文件传输", "nyy", "拿呀呀"],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-16.png?v=20260607-no-halo", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png?v=20260607-no-halo", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png?v=20260607-no-halo", sizes: "192x192", type: "image/png" },
    ],
    shortcut: [{ url: "/icons/favicon-32.png?v=20260607-no-halo", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png?v=20260607-no-halo", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "拿呀呀",
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
            __html: `(function(){try{var t=localStorage.getItem("nyy-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
