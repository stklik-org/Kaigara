import { useEffect, useState, type ReactNode } from "react";
import { readString, writeString } from "@/lib/storage";
import { ThemeContext, type ResolvedTheme } from "./ThemeContext";

const STORAGE_KEY = "kaigara-theme";

const isTheme = (value: string): value is ResolvedTheme => value === "light" || value === "dark";

function initialTheme(): ResolvedTheme {
  const stored = readString(STORAGE_KEY, isTheme);
  if (stored) return stored;
  // No explicit choice saved yet — default from the OS preference, one time only. There is no
  // "system" mode to return to after that; toggling just flips light/dark from here on.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the chosen theme by stamping `data-theme` on <html> — index.css's `[data-theme=…]`
 *  block does the actual re-theming, so no component needs a `dark:` variant. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ResolvedTheme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writeString(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{ theme, toggleTheme: () => setTheme((prev) => (prev === "light" ? "dark" : "light")) }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
