import { NavLink, Outlet } from "react-router-dom";
import { useTheme } from "./ThemeContext";

const STAGES: { path: string; label: string }[] = [
  { path: "/connect", label: "Connect" },
  { path: "/load", label: "Load" },
  { path: "/compose", label: "Compose" },
  { path: "/run", label: "Run" },
  { path: "/analyze", label: "Analyze" },
];

const ICON_PROPS = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SunIcon() {
  return (
    <svg {...ICON_PROPS} className="h-4 w-4">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2v2M10 16v2M18 10h-2M4 10H2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9 4.5 4.5" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS} className="h-4 w-4">
      <path d="M17 11.5A7 7 0 1 1 8.5 3a5.5 5.5 0 0 0 8.5 8.5Z" />
    </svg>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-border-strong text-ink-muted hover:text-ink"
    >
      {theme === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Replaces the old vertical LifecycleRail with a horizontal segmented-pill nav — see the
 *  "Load Composer" timeline prototype's toolbar (docs/Benchmark UI prototype). Click-to-jump,
 *  not a wizard, same as before. */
export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="text-sm font-semibold text-ink">Kaigara</div>
        <nav className="flex gap-1 rounded-full border border-border bg-surface-sunken p-1">
          {STAGES.map((stage) => (
            <NavLink
              key={stage.path}
              to={stage.path}
              className={({ isActive }) =>
                `rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  isActive ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
                }`
              }
            >
              {stage.label}
            </NavLink>
          ))}
        </nav>
        <ThemeToggle />
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
