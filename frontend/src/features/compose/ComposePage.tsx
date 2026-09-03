import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ServerConnection } from "@kaigara/shared-types";
import { useApi } from "../../lib/api/ApiContext";
import { RunRequestError } from "../../lib/api/runsClient";
import { Button } from "../../components/ui/Button";
import { ResizableRows } from "../../components/ui/ResizableRows";
import { useScenarioStore } from "./store/scenarioStore";
import { TimelineView } from "./timeline/TimelineView";
import { LoadShapePanel, RequestTargetPanel } from "./timeline/InfoPanels";
import { CodeEditorView } from "./editor/CodeEditorView";
import { ExpectedRequestsChart } from "./overlay/ExpectedRequestsChart";
import {
  SCALE_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from "./timeline/timelineConstants";

const SIDEBAR_WIDTH_STORAGE_KEY = "kaigara.compose.sidebarWidth";

function readStoredSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_WIDTH_MIN && stored <= SIDEBAR_WIDTH_MAX) return stored;
  } catch {
    /* private mode / disabled storage — fall through to the default */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

// Pane sizing (px) for the three stacked regions of the Visual view. The timeline is the `flex`
// row — it soaks up whatever the info panel and the overlay don't take — so only its *minimum*
// is set here; the other two carry a min + a first-open default.
const INFO_MIN_HEIGHT = 132;
const INFO_DEFAULT_HEIGHT = 252;
const INFO_MAX_HEIGHT = 620;
const TIMELINE_MIN_HEIGHT = 156;
const OVERLAY_MIN_HEIGHT = 190;
const OVERLAY_DEFAULT_HEIGHT = 248;
const OVERLAY_MAX_HEIGHT = 520;
const OVERLAY_COLLAPSED_HEIGHT = 30;
// Chart chrome above the plot area (heading + legend + padding); the rest of the pane is plot.
const OVERLAY_CHART_CHROME = 100;

/** The new timeline-based Compose screen — replaces the old xyflow Method-graph canvas. Layout
 *  mirrors the wireframe's Load Composer: the two info panels on top (not a side inspector), the
 *  timeline in the middle, and the combined-throughput overlay chart at the bottom, stacked in a
 *  ResizableRows splitter so each region can be dragged to size (persisted across reloads).
 *  Visual is the default/primary interaction; Code is a live, schema-validated JSON view of the
 *  exact same document (see scenarioStore) — not a separate export/import step. */
export function ComposePage() {
  const api = useApi();
  const navigate = useNavigate();
  const scenarioName = useScenarioStore((s) => s.scenarioName);
  const timeline = useScenarioStore((s) => s.timeline);
  const loadScenario = useScenarioStore((s) => s.loadScenario);
  const mode = useScenarioStore((s) => s.viewMode);
  const setMode = useScenarioStore((s) => s.setViewMode);
  // Lifted out of TimelineView so the Expected Requests overlay chart below it can share the
  // exact same zoom level and horizontal scroll position — see TimelineView's onScrollMetricsChange.
  const [scaleWidth, setScaleWidth] = useState(SCALE_WIDTH_DEFAULT);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineContentWidth, setTimelineContentWidth] = useState(0);
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  // Track-name column width. Owned here (not in TimelineView) because the overlay chart's y-axis
  // gutter has to match it to stay x-aligned with the timeline above.
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [activeConnection, setActiveConnection] = useState<ServerConnection | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Which target a run would go against. Read once here rather than at click time so the Run
  // button can say where it is about to send load before it is pressed.
  useEffect(() => {
    let cancelled = false;
    api.connections.list().then((connections) => {
      if (!cancelled) setActiveConnection(connections.find((connection) => connection.active) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Serializes the composed timeline and hands it to the orchestrator, then follows the run. */
  async function handleRun() {
    if (!activeConnection) {
      setStartError("No active connection — pick a target on the Connect screen first.");
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const run = await api.runs.start({
        timeline,
        connection: activeConnection,
        scenarioName: scenarioName || undefined,
      });
      navigate(`/run?runId=${encodeURIComponent(run.id)}`);
    } catch (error) {
      // Validation failures come back with per-path issues; lead with the first one, since it is
      // far more actionable than "422 Unprocessable Entity".
      const issues = error instanceof RunRequestError ? error.issues.filter((i) => i.severity === "error") : [];
      setStartError(issues.length > 0 ? `${issues[0].path || "timeline"}: ${issues[0].message}` : (error as Error).message);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(sidebarWidth)));
    } catch {
      /* storage unavailable — width still works this session, just isn't remembered */
    }
  }, [sidebarWidth]);

  useEffect(() => {
    // The Load screen already populates the store via loadScenario() before navigating here —
    // this fallback only fires on a direct/deep link straight to /compose with nothing loaded.
    if (timeline.tracks.length > 0) return;
    let cancelled = false;
    api.scenarios.instantiate("component-manufacturer").then((scenario) => {
      if (!cancelled) loadScenario(scenario);
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadScenario, timeline.tracks.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-1 rounded-md border border-border-strong p-0.5">
          <button
            type="button"
            onClick={() => setMode("visual")}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              mode === "visual" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={() => setMode("code")}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              mode === "code" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            Code
          </button>
        </div>
        <div className="text-sm font-medium text-ink">{scenarioName || "Loading scenario…"}</div>
        <div className="ml-auto flex items-center gap-2">
          {startError && (
            <span className="max-w-md truncate text-xs text-status-fail" title={startError}>
              {startError}
            </span>
          )}
          <Button variant="secondary" title="Not wired up yet">
            Save
          </Button>
          <Button
            variant="primary"
            disabled={starting || timeline.tracks.length === 0}
            title={
              activeConnection
                ? `Run against ${activeConnection.name} (${activeConnection.baseUrl})`
                : "Activate a server connection on the Connect screen first"
            }
            onClick={handleRun}
          >
            {starting ? "Starting…" : "Run"}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mode === "visual" ? (
          <ResizableRows
            className="h-full"
            storageKey="kaigara.compose.paneSizes"
            rows={[
              {
                key: "info",
                minHeight: INFO_MIN_HEIGHT,
                defaultHeight: INFO_DEFAULT_HEIGHT,
                maxHeight: INFO_MAX_HEIGHT,
                render: () => (
                  <div className="grid h-full grid-cols-2 divide-x divide-border overflow-y-auto border-b border-border bg-surface">
                    <LoadShapePanel />
                    <RequestTargetPanel />
                  </div>
                ),
              },
              {
                key: "timeline",
                flex: true,
                minHeight: TIMELINE_MIN_HEIGHT,
                handleLabel: "Resize timeline panel",
                render: (height) => (
                  <div className="h-full border-t border-border bg-surface">
                    <TimelineView
                      height={height}
                      scaleWidth={scaleWidth}
                      onScaleWidthChange={setScaleWidth}
                      sidebarWidth={sidebarWidth}
                      onSidebarWidthChange={setSidebarWidth}
                      onScrollMetricsChange={({ scrollLeft, viewportWidth, contentWidth }) => {
                        setTimelineScrollLeft(scrollLeft);
                        setTimelineViewportWidth(viewportWidth);
                        setTimelineContentWidth(contentWidth);
                      }}
                    />
                  </div>
                ),
              },
              {
                key: "overlay",
                minHeight: OVERLAY_MIN_HEIGHT,
                defaultHeight: OVERLAY_DEFAULT_HEIGHT,
                maxHeight: OVERLAY_MAX_HEIGHT,
                collapsedHeight: overlayCollapsed ? OVERLAY_COLLAPSED_HEIGHT : undefined,
                handleLabel: "Resize expected requests overlay",
                render: (height) =>
                  overlayCollapsed ? (
                    <button
                      type="button"
                      onClick={() => setOverlayCollapsed(false)}
                      className="flex h-full w-full items-center justify-center gap-1.5 border-t border-border bg-surface-sunken text-[11px] font-medium text-ink-muted hover:text-ink"
                    >
                      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7.5 6 4.5 9 7.5" />
                      </svg>
                      Show expected requests overlay
                    </button>
                  ) : (
                    <div className="relative h-full overflow-hidden border-t border-border bg-surface">
                      <button
                        type="button"
                        onClick={() => setOverlayCollapsed(true)}
                        title="Hide expected requests overlay"
                        className="absolute right-2 top-2 z-10 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink"
                      >
                        ▾ Hide
                      </button>
                      <ExpectedRequestsChart
                        tracks={timeline.tracks}
                        totalDurationSeconds={timeline.totalDurationSeconds}
                        scaleWidth={scaleWidth}
                        scrollLeft={timelineScrollLeft}
                        viewportWidth={timelineViewportWidth}
                        contentWidth={timelineContentWidth}
                        plotHeight={Math.max(90, height - OVERLAY_CHART_CHROME)}
                        gutterWidth={sidebarWidth}
                      />
                    </div>
                  ),
              },
            ]}
          />
        ) : (
          <CodeEditorView />
        )}
      </div>
    </div>
  );
}
