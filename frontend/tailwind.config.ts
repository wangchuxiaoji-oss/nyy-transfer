import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        border: "var(--border)",
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        nyy: {
          50: "#fff8f1",
          100: "#fff0e0",
          200: "#ffdcb8",
          300: "#ffc285",
          400: "#ffa04d",
          500: "#FF8A3D", // brand primary
          600: "#e36a1f",
          700: "#bc4f14",
          800: "#963f16",
          900: "#7a3515",
        },
        action: {
          DEFAULT: "#bc4f14",
          hover: "#963f16",
          active: "#7a3515",
        },
        warm: {
          50: "#fefcf9",
          100: "#fdf6ed",
          200: "#f9ead4",
        },
        // 4C 复古未来色系
        yc: {
          bg: "#0A0418",
          "mesh-1": "#2A0845",
          "mesh-2": "#6441A5",
          surface: "rgba(255,255,255,0.06)",
          "surface-s": "rgba(255,255,255,0.12)",
          accent: "#FF8A3D",
          "accent-2": "#00D4FF",
          "accent-3": "#FF3366",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
        tech: ["Orbitron", "var(--font-geist-sans)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
      animation: {
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        "scan-line": "scan-line 1.2s ease-in-out",
        "vault-open": "vault-open 0.6s cubic-bezier(0.16,1,0.3,1) both",
        "fade-in": "fade-in 0.5s cubic-bezier(0.16,1,0.3,1) both",
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 20px rgba(255,138,61,0.5)" },
          "50%": { boxShadow: "0 0 40px rgba(255,138,61,0.8)" },
        },
        "scan-line": {
          "0%": { transform: "translateY(-100%)", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { transform: "translateY(100%)", opacity: "0" },
        },
        "vault-open": {
          from: { opacity: "0", transform: "scale(0.95)", filter: "blur(6px)" },
          to: { opacity: "1", transform: "scale(1)", filter: "blur(0)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
