"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

export type Theme = "light" | "dark" | "auto";

interface ThemeContextValue {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "auto",
  resolved: "light",
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("auto");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Initialize from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("nyy-theme") as Theme | null;
    const t = stored && ["light", "dark", "auto"].includes(stored) ? stored : "auto";
    setThemeState(t);
    const r = t === "auto" ? getSystemTheme() : t;
    setResolved(r);
    applyTheme(r);
  }, []);

  // Listen for system theme changes when in auto mode
  useEffect(() => {
    if (theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const r = e.matches ? "dark" : "light";
      setResolved(r);
      applyTheme(r);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem("nyy-theme", t);
    const r = t === "auto" ? getSystemTheme() : t;
    setResolved(r);
    applyTheme(r);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}