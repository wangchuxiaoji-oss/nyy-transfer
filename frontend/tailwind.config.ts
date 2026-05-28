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
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
export default config;
