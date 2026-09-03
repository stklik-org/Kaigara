import { useEffect, useState, type ReactNode } from "react";
import { ThemeContext, type ResolvedTheme } from "./ThemeContext";

const STORAGE_KEY = "kaigara-theme";

function initialTheme(): ResolvedTheme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // No explicit choice saved yet — default from the OS preference, one time only. There's no
  // "system" mode to return to after that; toggling just flips light/dark from here on.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the chosen theme by stamping `data-theme` on <html> — index.css's `[data-theme=...]`
 *  blocks do the actual re-theming, so no component needs a `dark:` variant. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ResolvedTheme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
