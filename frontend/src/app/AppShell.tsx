import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { HeaderSlotsProvider } from "./HeaderSlots";
import { useTheme } from "./ThemeContext";

/** The lifecycle stages, in order. Click-to-jump, not a wizard — nothing here enforces a sequence,
 *  because a benchmark is routinely re-run, re-composed and re-analyzed out of order. */
const STAGES = [
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
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "h-4 w-4",
} as const;

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2v2M10 16v2M18 10h-2M4 10H2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9 4.5 4.5" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M17 11.5A7 7 0 1 1 8.5 3a5.5 5.5 0 0 0 8.5 8.5Z" />
    </svg>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-border-strong text-ink-muted hover:text-ink"
    >
      {theme === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** The frame every screen renders inside: the horizontal segmented-pill stage nav and the theme
 *  toggle, over an <Outlet> that owns the rest of the viewport.
 *
 *  The two empty divs either side of the nav are HeaderSlots.tsx's portal targets — a route with
 *  its own title-bar content (Compose's scenario name/view toggle, its Upload/Download/Save/Run
 *  actions) renders into them instead of opening a second header row below this one. State, not a
 *  plain ref, because a portal needs the target DOM node to *exist* (and trigger a re-render when
 *  it first does) before anything can render into it — a ref alone updates silently. */
export function AppShell() {
  const [scenarioSlotEl, setScenarioSlotEl] = useState<HTMLDivElement | null>(null);
  const [actionsSlotEl, setActionsSlotEl] = useState<HTMLDivElement | null>(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="flex flex-none items-center gap-3">
          <div className="text-sm font-semibold text-ink">Kaigara</div>
          <div ref={setScenarioSlotEl} className="flex min-w-0 items-center gap-2" />
        </div>
        {/* `mx-auto` (not `justify-between` on the header) is what keeps the nav truly centred: it
            eats all the row's remaining space evenly on both sides, regardless of how wide the
            slots either side of it happen to be on a given route. */}
        <nav className="mx-auto flex flex-none gap-1 rounded-full border border-border bg-surface-sunken p-1">
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
        <div className="flex flex-none items-center gap-2">
          <div ref={setActionsSlotEl} className="flex items-center gap-2" />
          <ThemeToggle />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <HeaderSlotsProvider value={{ scenario: scenarioSlotEl, actions: actionsSlotEl }}>
          <Outlet />
        </HeaderSlotsProvider>
      </main>
    </div>
  );
}
