import { createContext, useContext } from "react";

export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  theme: ResolvedTheme;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme() must be used within a <ThemeProvider>");
  return ctx;
}
