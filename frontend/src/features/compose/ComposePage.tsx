import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { withAssignedTrackColors } from "@kaigara/shared-types";
import { HeaderActionsSlot, HeaderScenarioSlot } from "@/app/HeaderSlots";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { ResizableColumns } from "@/components/ui/ResizableColumns";
import { ResizableRows } from "@/components/ui/ResizableRows";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useApi } from "@/lib/api/ApiContext";
import { editTimeline } from "@/lib/assist/editTimeline";
import { loadLlmConfig } from "@/lib/assist/llmConfig";
import { readNumberInRange, writeString } from "@/lib/storage";
import { useAsyncData } from "@/lib/useAsyncData";
import { AiEditDialog } from "./AiEditDialog";
import { CodeEditorView } from "./editor/CodeEditorView";
import { parseText, toText } from "./editor/scenarioSerialization";
import { ExpectedRequestsChart } from "./overlay/ExpectedRequestsChart";
import { CataloguePanel } from "./panels/CataloguePanel";
import { CompositionPanel } from "./panels/CompositionPanel";
import { LoadShapePanel } from "./panels/LoadShapePanel";
import { ParameterDialog } from "./panels/ParameterDialog";
import type { CatalogDraft } from "./panels/catalogDraft";
import { DEFAULT_SCENARIO_NAME, useScenarioStore, type ComposeViewMode } from "./store/scenarioStore";
import { TimelineView, type ScrollMetrics } from "./timeline/TimelineView";
import {
  SCALE_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./timeline/timelineConstants";

const SIDEBAR_WIDTH_KEY = "kaigara.compose.sidebarWidth";
const PANE_SIZES_KEY = "kaigara.compose.paneSizes";
const INFO_COLUMN_SIZES_KEY = "kaigara.compose.infoColumns";

const VIEW_MODE_OPTIONS: { value: ComposeViewMode; label: string }[] = [
  { value: "visual", label: "Visual" },
  { value: "code", label: "Code" },
];

// Pane sizing (px) for the three stacked regions of the Visual view. The timeline is the `flex`
// row — it soaks up whatever the info panel and the overlay don't take — so only its *minimum* is
// set here; the other two carry a minimum plus a first-open default.
// The info row holds the payload editor now (load shape · composition · catalogue), so it opens
// taller than the old two-panel row did — a catalogue two cards high is not worth showing.
const INFO_MIN_HEIGHT = 150;
const INFO_DEFAULT_HEIGHT = 384;
const INFO_MAX_HEIGHT = 720;
const TIMELINE_MIN_HEIGHT = 156;
const EDITOR_MIN_HEIGHT = 156;
const OVERLAY_MIN_HEIGHT = 190;
const OVERLAY_DEFAULT_HEIGHT = 248;
const OVERLAY_MAX_HEIGHT = 520;
const OVERLAY_COLLAPSED_HEIGHT = 30;
/** Chart chrome above the plot area (heading + legend + padding); the rest of the pane is plot. */
const OVERLAY_CHART_CHROME = 100;

/** The Code view has no scrollable timeline canvas above the overlay to stay pixel-aligned with,
 *  so it renders the chart at its own natural width instead of TimelineView's live scroll — see
 *  ExpectedRequestsChart's `scroll` doc. A stable module-level object so it never triggers the
 *  chart's memoized curves to recompute across renders. */
const NO_SCROLL: ScrollMetrics = { scrollLeft: 0, viewportWidth: 0, contentWidth: 0 };

/** Scenario name → filename stem for the downloaded JSON, e.g. "Component manufacturer" →
 *  "component-manufacturer". Falls back to "timeline" at the call site for a name that strips to
 *  nothing (all punctuation, say). */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ChevronUpIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5 6 4.5 9 7.5" />
    </svg>
  );
}

/** A shaft plus an open chevron at its tip — deliberately just an arrow, no tray line underneath,
 *  to match {@link UploadArrowIcon} as a mirrored pair. */
function DownloadArrowIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3v10" />
      <path d="M5.5 9.5 10 14l4.5-4.5" />
    </svg>
  );
}

function UploadArrowIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 17V7" />
      <path d="M5.5 10.5 10 6l4.5 4.5" />
    </svg>
  );
}

/** Two four-point stars — the conventional "AI action" glyph. Sits on the AI edit button between
 *  the stage nav and the Upload/Download pair. */
function AiSparkleIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11.5 2.5 13 6.7 17.2 8.2 13 9.7 11.5 13.9 10 9.7 5.8 8.2 10 6.7 11.5 2.5Z" />
      <path d="M5.5 12.5 6.2 14.6 8.3 15.3 6.2 16 5.5 18.1 4.8 16 2.7 15.3 4.8 14.6 5.5 12.5Z" />
    </svg>
  );
}

/** Icon-only twin of {@link Button} — same border-strong/muted-ink resting state as the theme
 *  toggle in AppShell, sized to just its glyph rather than a text button's padding. Used for the
 *  Download/Upload timeline actions, which read better as a compact pair of glyphs next to Save. */
function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-border-strong text-ink-muted transition-colors hover:text-ink"
    >
      {children}
    </button>
  );
}

/** The scenario name, editable directly in the header. Mirrors `useMMSSDraft.ts`'s focus-tracking
 *  discipline (kept local while focused, so an external rename — e.g. from
 *  {@link NameScenarioDialog} confirming — can't fight mid-keystroke text; synced from the model
 *  the instant focus leaves) without actually building on that hook, which is shaped around m:ss
 *  parsing rather than plain text. Commits trimmed-non-empty on blur/Enter; Escape reverts. */
function ScenarioNameField({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const [text, setText] = useState(name);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(name);
  }, [name, focused]);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed && trimmed !== name) onCommit(trimmed);
    setText(trimmed || name);
  }

  return (
    <input
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={(event) => {
        setFocused(false);
        commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setText(name);
          event.currentTarget.blur();
        }
      }}
      aria-label="Scenario name"
      title="Rename this scenario"
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-ink outline-none hover:border-border-strong focus:border-accent focus:bg-surface"
    />
  );
}

/** Blocks Download while the scenario is still called {@link DEFAULT_SCENARIO_NAME} — a literal
 *  "untitled-scenario.json" is not a useful thing to find in a Downloads folder later. Confirming
 *  both renames the scenario for good (through the same `setScenarioName` the header field itself
 *  uses, not a one-off filename) and proceeds with the download in one step; the backdrop, Cancel,
 *  or Escape all back out without downloading or touching the name. */
function NameScenarioDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

  function confirm() {
    if (trimmed) onConfirm(trimmed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={onCancel}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Name this scenario"
        className="w-full max-w-sm p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold text-ink">Name this scenario</div>
        <p className="mt-1 text-xs text-ink-muted">
          "{DEFAULT_SCENARIO_NAME}" isn't a useful filename — give it a real name before downloading.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") confirm();
            if (event.key === "Escape") onCancel();
          }}
          placeholder="Scenario name"
          className="mt-3 w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!trimmed} onClick={confirm}>
            Name &amp; download
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** Shown instead of the whole editor when nothing has been chosen yet — a deep link straight to
 *  /compose, or the very first visit. Deliberately not an auto-loaded demo scenario (that used to
 *  be the fallback here): opening someone else's data by default is a worse surprise than an empty
 *  screen with two obvious ways forward. `dashed` matches the wireframe's not-yet-populated
 *  convention (see components/ui/Panel.tsx). */
function ComposeEmptyState({ onGoToLoad, onInitialize }: { onGoToLoad: () => void; onInitialize: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel dashed className="max-w-md p-6 text-center">
        <div className="text-sm font-semibold text-ink">Nothing to compose yet</div>
        <p className="mt-2 text-sm text-ink-muted">
          Compose edits a scenario's timeline. Open one from the library or a file on the Load
          screen, or start with a blank timeline here and build it up with tracks and Loads.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button variant="secondary" onClick={onInitialize}>
            Start a blank timeline
          </Button>
          <Button variant="primary" onClick={onGoToLoad}>
            Go to Load
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** The timeline-based Compose screen. Layout mirrors the wireframe's Load Composer: the two info
 *  panels on top (not a side inspector), the timeline in the middle, and the combined-throughput
 *  overlay chart at the bottom, stacked in a ResizableRows splitter so each region can be dragged
 *  to size (persisted across reloads). Visual is the default; Code is a live, schema-validated
 *  JSON view of the exact same document — not a separate export/import step.
 *
 *  The overlay is not Visual-only: both views end in their own ResizableRows with an "overlay" row
 *  of the same key, height bounds and collapsed state, so the chart reads as one persistent panel
 *  that happens to sit under whichever editor is active rather than two independent ones.
 *
 *  Renders {@link ComposeEmptyState} instead of any of that until something has actually been
 *  chosen — `scenarioName` empty is the store's true initial state, set only by `loadScenario`
 *  (the Load screen) or `initializeTimeline` (this screen's own "start blank" escape hatch), never
 *  invented here. A deep link straight to /compose used to auto-load a demo scenario; now it lands
 *  on the empty state like a fresh visit does. */
export function ComposePage() {
  const api = useApi();
  const navigate = useNavigate();
  const scenarioName = useScenarioStore((s) => s.scenarioName);
  const timeline = useScenarioStore((s) => s.timeline);
  const initializeTimeline = useScenarioStore((s) => s.initializeTimeline);
  const setScenarioName = useScenarioStore((s) => s.setScenarioName);
  const setTimeline = useScenarioStore((s) => s.setTimeline);
  const mode = useScenarioStore((s) => s.viewMode);
  const setMode = useScenarioStore((s) => s.setViewMode);

  // Zoom and horizontal scroll are lifted out of TimelineView so the Expected Requests chart below
  // can render at the exact same scale and offset — see TimelineView's onScrollMetricsChange.
  const [scaleWidth, setScaleWidth] = useState(SCALE_WIDTH_DEFAULT);
  const [scroll, setScroll] = useState<ScrollMetrics>({ scrollLeft: 0, viewportWidth: 0, contentWidth: 0 });
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  // Track-name column width. Owned here (not in TimelineView) because the overlay chart's y-axis
  // gutter has to match it to stay x-aligned with the timeline above.
  const [sidebarWidth, setSidebarWidth] = useState(
    () => readNumberInRange(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX) ?? SIDEBAR_WIDTH_DEFAULT,
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [namingForDownload, setNamingForDownload] = useState(false);
  const [aiEditOpen, setAiEditOpen] = useState(false);
  // The catalogue pick being configured. Owned here rather than in either panel because both the
  // catalogue (adding) and the composition list (editing) open the same dialog.
  const [draft, setDraft] = useState<CatalogDraft | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Which target a run would go against. Read here rather than at click time so the Run button can
  // say where it is about to send load before it is pressed.
  const { data: connections } = useAsyncData(() => api.connections.list(), [api]);
  const activeConnection = connections?.find((connection) => connection.active) ?? null;

  useEffect(() => {
    writeString(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  /** Saves the exact bytes the Code view shows — `toText`, the same writer, so a downloaded file
   *  round-trips through {@link handleUploadFile} (or a hand-edit, or the Load screen's drop zone,
   *  which reads the same `LoadTimeline` shape as its "bare method timeline" case) back to an
   *  identical document.
   *
   *  Prefers a real "Save As" dialog (the File System Access API — Chromium only) so the user
   *  actually picks a folder and can rename the file on the way out, rather than it landing
   *  silently whichever place the browser downloads to. Falls back to the classic Blob + `<a
   *  download>` trick everywhere else (Firefox, Safari, or an older Chromium): the browser's own
   *  download handling is the closest those get to a "choose where to save" dialog. */
  async function downloadTimelineAs(name: string) {
    const filename = `${slugify(name) || "timeline"}.json`;
    const text = toText(timeline);

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "JSON scenario timeline", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return;
      } catch (error) {
        // Closing the picker without choosing anywhere is a deliberate "never mind", not a
        // failure to recover from — anything else (a permissions error, say) falls through to
        // the plain download below instead of leaving the user with nothing.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  /** Still the default name → the file would be "untitled-scenario.json", which is not worth
   *  finding in a Downloads folder later. {@link NameScenarioDialog} both renames the scenario for
   *  good and triggers the actual download once it has a real name. */
  async function handleDownload() {
    if (scenarioName === DEFAULT_SCENARIO_NAME) {
      setNamingForDownload(true);
      return;
    }
    await downloadTimelineAs(scenarioName);
  }

  /** Reads a picked file through the same `parseText` the Code view debounces keystrokes through,
   *  so a file this rejects is rejected for the same reasons an invalid paste would be. Confirms
   *  before clobbering only when there is something to lose — a track with at least one Load —
   *  so replacing a still-blank "Start a blank timeline" canvas doesn't get an unnecessary prompt. */
  async function handleUploadFile(file: File) {
    setUploadError(null);
    const result = parseText(await file.text());
    if (!result.ok) {
      setUploadError(
        result.issues[0]
          ? `${result.issues[0].path || "timeline"}: ${result.issues[0].message}`
          : `Could not read ${file.name}.`,
      );
      return;
    }
    const hasData = timeline.tracks.some((track) => track.loads.length > 0);
    if (hasData && !window.confirm(`Replace the current timeline with "${file.name}"? This can't be undone.`)) {
      return;
    }
    setTimeline(result.timeline);
  }

  /** Sends the current timeline plus a plain-language instruction to the configured LLM and swaps
   *  in whatever it returns — validated by the same gate as a Code-view edit. `withAssignedTrackColors`
   *  gives any track the model added a palette colour while leaving the existing ones (which went
   *  out in the prompt with their `color`) untouched. Errors surface in the dialog. */
  async function applyAiEdit(instruction: string) {
    const edited = await editTimeline(timeline, instruction, loadLlmConfig());
    setTimeline(withAssignedTrackColors(edited));
  }

  /** Just opens the Run screen — it no longer launches the benchmark. Run compiles the timeline,
   *  shows the concrete plan, and has its own Run button next to Stop. */
  function goToRun() {
    navigate("/run");
  }

  /** The overlay row's body, shared by both view modes (see the component doc comment): a
   *  collapsed strip, or the chart itself with its own "Hide" affordance. `scroll` is the one
   *  thing that differs per caller — Visual passes TimelineView's live metrics so the two stay
   *  pixel-aligned, Code passes {@link NO_SCROLL} since it has no timeline canvas to align with. */
  function renderOverlayRow(height: number, scrollMetrics: ScrollMetrics) {
    if (overlayCollapsed) {
      return (
        <button
          type="button"
          onClick={() => setOverlayCollapsed(false)}
          className="flex h-full w-full items-center justify-center gap-1.5 border-t border-border bg-surface-sunken text-[11px] font-medium text-ink-muted hover:text-ink"
        >
          <ChevronUpIcon />
          Show expected requests overlay
        </button>
      );
    }
    return (
      <div className="relative h-full overflow-hidden border-t border-border bg-surface">
        <button
          type="button"
          onClick={() => setOverlayCollapsed(true)}
          title="Hide expected requests overlay"
          className="absolute top-2 right-2 z-10 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink"
        >
          ▾ Hide
        </button>
        <ExpectedRequestsChart
          tracks={timeline.tracks}
          totalDurationSeconds={timeline.totalDurationSeconds}
          scaleWidth={scaleWidth}
          scroll={scrollMetrics}
          plotHeight={Math.max(90, height - OVERLAY_CHART_CHROME)}
          gutterWidth={sidebarWidth}
        />
      </div>
    );
  }

  if (!scenarioName) {
    return <ComposeEmptyState onGoToLoad={() => navigate("/load")} onInitialize={initializeTimeline} />;
  }

  return (
    <>
      {/* Merged into AppShell's own header (see HeaderSlots.tsx) rather than a second bar here:
          the view toggle and name between "Kaigara" and the pill nav, the document actions right
          before the theme toggle. */}
      <HeaderScenarioSlot>
        <SegmentedControl label="Compose view" value={mode} options={VIEW_MODE_OPTIONS} onChange={setMode} />
        <ScenarioNameField name={scenarioName} onCommit={setScenarioName} />
      </HeaderScenarioSlot>
      <HeaderActionsSlot>
        {uploadError && (
          <span className="max-w-md truncate text-xs text-status-fail" title={uploadError}>
            {uploadError}
          </span>
        )}
        <IconButton title="Edit timeline with AI" onClick={() => setAiEditOpen(true)}>
          <AiSparkleIcon />
        </IconButton>
        <IconButton title="Upload timeline from a JSON file" onClick={() => uploadInputRef.current?.click()}>
          <UploadArrowIcon />
        </IconButton>
        <IconButton title="Download timeline as a JSON file" onClick={() => void handleDownload()}>
          <DownloadArrowIcon />
        </IconButton>
        <input
          ref={uploadInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset so re-picking the same filename (e.g. after fixing it on disk) still fires.
            event.target.value = "";
            if (file) void handleUploadFile(file);
          }}
        />
        <Button variant="secondary" title="Not wired up yet">
          Save
        </Button>
        <Button
          variant="primary"
          disabled={timeline.tracks.length === 0}
          title={
            activeConnection
              ? `Open the Run screen (targets ${activeConnection.name})`
              : "Open the Run screen — activate a connection there before starting"
          }
          onClick={goToRun}
        >
          Run
        </Button>
      </HeaderActionsSlot>

      {draft && <ParameterDialog draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />}

      {aiEditOpen && <AiEditDialog onClose={() => setAiEditOpen(false)} onApply={applyAiEdit} />}

      {namingForDownload && (
        <NameScenarioDialog
          onCancel={() => setNamingForDownload(false)}
          onConfirm={(name) => {
            setScenarioName(name);
            setNamingForDownload(false);
            void downloadTimelineAs(name);
          }}
        />
      )}

      <div className="h-full min-h-0">
        {mode === "visual" ? (
          <ResizableRows
            className="h-full"
            storageKey={PANE_SIZES_KEY}
            rows={[
              {
                key: "info",
                minHeight: INFO_MIN_HEIGHT,
                defaultHeight: INFO_DEFAULT_HEIGHT,
                maxHeight: INFO_MAX_HEIGHT,
                render: () => (
                  <ResizableColumns
                    className="h-full border-b border-border bg-surface"
                    storageKey={INFO_COLUMN_SIZES_KEY}
                    columns={[
                      // Opens at a quarter each for the two inspectors, leaving the catalogue —
                      // the flex column, and the panel being browsed — the other half. Fractions
                      // rather than pixels so the split holds on any window; the maxima are only
                      // there to stop a drag swallowing the row, so they sit well clear of 25%.
                      {
                        key: "shape",
                        minWidth: 168,
                        defaultFraction: 0.25,
                        maxWidth: 640,
                        render: () => <LoadShapePanel />,
                      },
                      {
                        key: "composition",
                        minWidth: 240,
                        defaultFraction: 0.25,
                        maxWidth: 900,
                        handleLabel: "Resize the request composition panel",
                        render: () => <CompositionPanel onEdit={setDraft} />,
                      },
                      {
                        key: "catalogue",
                        flex: true,
                        minWidth: 260,
                        handleLabel: "Resize the request catalogue panel",
                        render: () => <CataloguePanel onPick={setDraft} />,
                      },
                    ]}
                  />
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
                      onScrollMetricsChange={setScroll}
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
                render: (height) => renderOverlayRow(height, scroll),
              },
            ]}
          />
        ) : (
          <ResizableRows
            className="h-full"
            storageKey={PANE_SIZES_KEY}
            rows={[
              {
                key: "editor",
                flex: true,
                minHeight: EDITOR_MIN_HEIGHT,
                render: () => <CodeEditorView />,
              },
              {
                key: "overlay",
                minHeight: OVERLAY_MIN_HEIGHT,
                defaultHeight: OVERLAY_DEFAULT_HEIGHT,
                maxHeight: OVERLAY_MAX_HEIGHT,
                collapsedHeight: overlayCollapsed ? OVERLAY_COLLAPSED_HEIGHT : undefined,
                handleLabel: "Resize expected requests overlay",
                render: (height) => renderOverlayRow(height, NO_SCROLL),
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
