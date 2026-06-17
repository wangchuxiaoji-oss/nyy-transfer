"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "@/components/theme-provider";

const cycle: Theme[] = ["auto", "light", "dark"];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  const next = () => {
    const idx = cycle.indexOf(theme);
    setTheme(cycle[(idx + 1) % cycle.length]);
  };

  const label =
    theme === "light" ? "浅色模式" : theme === "dark" ? "深色模式" : "跟随系统";

  return (
    <button
      onClick={next}
      aria-label={`当前：${label}，点击切换`}
      title={label}
      className={`retro-nav-button h-11 w-11 ${className}`}
    >
      {theme === "light" && <Sun size={20} />}
      {theme === "dark" && <Moon size={20} />}
      {theme === "auto" && <Monitor size={20} />}
    </button>
  );
}
