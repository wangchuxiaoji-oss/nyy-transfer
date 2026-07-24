import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".next-playwright/**",
    ".next-production-a/**",
    ".next-production-b/**",
    ".next-releases/**",
    "playwright-report/**",
    "test-results/**",
    "public/tmp/**",
    "public/libav-ac3/**",
    "public/pdfjs/**",
    "public/pdf.min.mjs",
    "public/pdf.worker.min.mjs",
  ]),
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
]);
