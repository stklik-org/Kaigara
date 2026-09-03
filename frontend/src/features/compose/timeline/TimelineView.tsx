import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Timeline } from "@xzdarcy/react-timeline-editor";
import type { TimelineRow } from "@xzdarcy/timeline-engine";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import "./timeline-theme.css";
import { useScenarioStore } from "../store/scenarioStore";
import { toTimelineRows, applyTimelineRows, buildEffects, coverLoads } from "./timelineAdapters";
import { renderAction } from "./ActionRenderer";
import { renderScale } from "./ScaleRenderer";
import { createLoad, defaultKindForTrack } from "./shapeVisuals";
import { formatMMSS, parseMMSS } from "./formatTime";
import { TrackLabelSidebar } from "./TrackLabelSidebar";
import {
  SCALE_SECONDS,
  SCALE_WIDTH_MIN,
  SCALE_WIDTH_MAX,
  SCALE_WIDTH_STEP,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from "./timelineConstants";

const ROW_HEIGHT = 44;
const SNAP_SECONDS = 5;
// Floor for the "Total length" field — a timeline shorter than a single major tick (one minute)
// isn't a meaningful thing to compose against.
const MIN_TOTAL_SECONDS = SCALE_SECONDS;
// Matches @xzdarcy/react-timeline-editor's own hardcoded `.timeline-editor-time-area` height —
// not configurable via props, so our label sidebar's header div has to match it by hand.
const TIME_AREA_HEIGHT_PX = 32;
// Left inset before the t=0 gridline, in px. This is the library's own default; we pass it back
// explicitly (below) so the end-of-timeline marker can use the same time→pixel mapping the library
// uses to place actions: pixelX = START_LEFT + (seconds / scale) * scaleWidth.
const TIMELINE_START_LEFT = 20;
// The library virtualizes rows/actions via react-virtualized, whose actual scrolling DOM node
// lives at this selector — not part of any public API, so this is a bit brittle across library
// upgrades, but it's the only way to mirror horizontal scroll onto the overlay chart and vertical
// scroll onto the sidebar (there's no onScroll prop on either axis).
const SCROLL_GRID_SELECTOR = ".timeline-editor-edit-area .ReactVirtualized__Grid";

const effects = buildEffects();

/** The timeline toolbar's "Total length" field — an `m:ss` (or plain-seconds) text box bound to
 *  `LoadTimeline.totalDurationSeconds`. Keeps a local draft string while focused so mid-typing
 *  states like "1:" aren't fought by reformat-on-keystroke; commits on blur/Enter, snapping to the
 *  5s grid and clamping to one tick minimum, and reverts to the last good value on unparseable
 *  input. Dragging or adding a Load past this value grows it back automatically (see coverLoads). */
function TotalLengthField() {
  const totalDurationSeconds = useScenarioStore((s) => s.timeline.totalDurationSeconds);
  const setTotalDuration = useScenarioStore((s) => s.setTotalDuration);
  const [text, setText] = useState(() => formatMMSS(totalDurationSeconds));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatMMSS(totalDurationSeconds));
  }, [totalDurationSeconds, focused]);

  function commit(raw: string) {
    const parsed = parseMMSS(raw);
    if (parsed === null) {
      setText(formatMMSS(totalDurationSeconds));
      return;
    }
    const next = Math.max(MIN_TOTAL_SECONDS, Math.round(parsed / SNAP_SECONDS) * SNAP_SECONDS);
    setTotalDuration(next);
    setText(formatMMSS(next));
  }

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
      <span>Total length</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="m:ss"
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-16 rounded border border-border-strong bg-transparent px-1.5 py-0.5 text-center font-mono text-ink outline-none focus:border-accent"
        title="Total timeline length (m:ss) — Loads placed past this grow it automatically"
      />
    </label>
  );
}

/** Wraps <Timeline> from @xzdarcy/react-timeline-editor. The library has no concept of a track
 *  label column, so TrackLabelSidebar renders our own, kept in sync purely by using the same
 *  rowHeight for both. Vertical scroll from the library's virtualized grid is mirrored onto the
 *  sidebar imperatively (via sidebarScrollRef) — no state, no re-render. Horizontal scroll and
 *  zoom are lifted to ComposePage so the Expected Requests overlay can share them.
 *
 *  `height` is the pixel height ComposePage's resizable-pane splitter has allotted this panel;
 *  the library virtualizes rows, so a short height just shows fewer tracks with an internal
 *  scrollbar (mirrored onto the sidebar) rather than clipping. */
export function TimelineView({
  scaleWidth,
  onScaleWidthChange,
  onScrollMetricsChange,
  height,
  sidebarWidth,
  onSidebarWidthChange,
}: {
  scaleWidth: number;
  onScaleWidthChange: (scaleWidth: number) => void;
  onScrollMetricsChange: (metrics: { scrollLeft: number; viewportWidth: number; contentWidth: number }) => void;
  height: number;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
}) {
  const timeline = useScenarioStore((s) => s.timeline);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const setTimeline = useScenarioStore((s) => s.setTimeline);
  const selectLoad = useScenarioStore((s) => s.selectLoad);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const stageLoad = useScenarioStore((s) => s.stageLoad);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const lastMetricsRef = useRef<{ scrollLeft: number; viewportWidth: number; contentWidth: number } | null>(null);
  // Local mirror of the grid's horizontal scroll, only so the end-of-timeline marker can track it.
  const [scrollLeft, setScrollLeft] = useState(0);

  const editorData = useMemo(
    () => toTimelineRows(timeline.tracks, selectedLoadId, pendingLoad),
    [timeline.tracks, selectedLoadId, pendingLoad],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let gridEl: HTMLElement | null = null;
    let rafId: number;

    function handleScroll() {
      if (!gridEl) return;
      const metrics = {
        scrollLeft: gridEl.scrollLeft,
        viewportWidth: gridEl.clientWidth,
        contentWidth: gridEl.scrollWidth,
      };
      const previous = lastMetricsRef.current;
      if (
        !previous ||
        previous.scrollLeft !== metrics.scrollLeft ||
        previous.viewportWidth !== metrics.viewportWidth ||
        previous.contentWidth !== metrics.contentWidth
      ) {
        lastMetricsRef.current = metrics;
        setScrollLeft(metrics.scrollLeft);
        onScrollMetricsChange(metrics);
      }
      // Mirror vertical scroll directly onto the sidebar rows container — imperative DOM write
      // avoids a React state round-trip and keeps the two halves pixel-perfect in sync.
      if (sidebarScrollRef.current) {
        sidebarScrollRef.current.scrollTop = gridEl.scrollTop;
      }
    }

    function attach() {
      gridEl = wrapper!.querySelector(SCROLL_GRID_SELECTOR);
      if (gridEl) {
        gridEl.addEventListener("scroll", handleScroll);
        handleScroll();
      } else {
        rafId = requestAnimationFrame(attach);
      }
    }
    attach();

    return () => {
      cancelAnimationFrame(rafId);
      gridEl?.removeEventListener("scroll", handleScroll);
    };
  }, [onScrollMetricsChange, scaleWidth, timeline.totalDurationSeconds, timeline.tracks.length]);

  function handleChange(rows: TimelineRow[]) {
    // Drag/resize writes straight back to the store's LoadTimeline; coverLoads then grows
    // totalDurationSeconds if a Load was pulled past the current end, so the model can't silently
    // fall out of step with the canvas.
    setTimeline(coverLoads(timeline.with({ tracks: applyTimelineRows(timeline.tracks, rows) })));
  }

  // --- track-name column width, dragged via the seam handle between the sidebar and the grid ---
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const clampSidebar = (w: number) => Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w));

  function beginSidebarResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    sidebarResizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }
  function onSidebarResize(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = sidebarResizeRef.current;
    if (!drag) return;
    onSidebarWidthChange(clampSidebar(drag.startWidth + (e.clientX - drag.startX)));
  }
  function endSidebarResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarResizeRef.current) return;
    sidebarResizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  // The library sizes its own scrollable extent to the furthest action (+5 ticks headroom) but no
  // less than `minScaleCount` ticks — so pinning that to the model's total length makes the
  // rendered timeline exactly as long as `totalDurationSeconds` whenever nothing hangs past it.
  // `maxScaleCount` is left unbounded so a Load can still be dragged out past the end (coverLoads
  // then bumps the total to match on drop).
  const minScaleCount = Math.max(1, Math.ceil(timeline.totalDurationSeconds / SCALE_SECONDS));

  // x (px, relative to the <Timeline> wrapper) of the totalDurationSeconds gridline, following the
  // library's own time→pixel mapping, minus how far the grid is scrolled. Hidden once it scrolls
  // off the left edge so it can't paint over the track-label sidebar.
  const endMarkerLeft =
    TIMELINE_START_LEFT + (timeline.totalDurationSeconds / SCALE_SECONDS) * scaleWidth - scrollLeft;

  function handleClickRow(e: MouseEvent, { row, time }: { row: TimelineRow; time: number }) {
    // The library's row click handler doesn't stop propagation, so clicking (or dragging) an
    // existing action also bubbles up here — without this guard every select/drag would also
    // add a brand-new Load underneath it. Only truly empty row background should add one.
    if ((e.target as HTMLElement).closest(".timeline-editor-action")) return;

    const snapped = Math.round(time / SNAP_SECONDS) * SNAP_SECONDS;
    const kind = defaultKindForTrack(row.id);
    const load = createLoad(kind, snapped);
    stageLoad(row.id, load);
    selectLoad(load.id);
  }

  return (
    <div className="flex w-full flex-col" style={{ height }}>
      <div className="flex flex-none items-center justify-between gap-3 px-2 py-1">
        <TotalLengthField />
        <div className="flex items-center gap-1.5">
          <span className="ml-1 text-[12px] text-ink-muted">Zoom</span>
          <button
            type="button"
            onClick={() => onScaleWidthChange(Math.max(SCALE_WIDTH_MIN, scaleWidth - SCALE_WIDTH_STEP))}
            className="flex h-6 w-6 items-center justify-center rounded border border-border-strong text-ink-muted hover:text-ink"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onScaleWidthChange(Math.min(SCALE_WIDTH_MAX, scaleWidth + SCALE_WIDTH_STEP))}
            className="flex h-6 w-6 items-center justify-center rounded border border-border-strong text-ink-muted hover:text-ink"
          >
            +
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <TrackLabelSidebar
          tracks={timeline.tracks}
          rowHeight={ROW_HEIGHT}
          timeAreaHeight={TIME_AREA_HEIGHT_PX}
          scrollRef={sidebarScrollRef}
          width={sidebarWidth}
        />
        {/* Column-width handle, overlaid on the sidebar↔grid seam so it takes no layout width
            (keeps the grid and the overlay chart's plot starting at the same x). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize track name column"
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={beginSidebarResize}
          onPointerMove={onSidebarResize}
          onPointerUp={endSidebarResize}
          onPointerCancel={endSidebarResize}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              onSidebarWidthChange(clampSidebar(sidebarWidth - 12));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              onSidebarWidthChange(clampSidebar(sidebarWidth + 12));
            }
          }}
          style={{ left: sidebarWidth }}
          className="group absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none focus-visible:outline-none"
        >
          {/* Sits exactly on the seam (the sidebar's own border-r is the resting line); a 2px
              accent bar fades in on hover/focus. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </div>
        <div ref={wrapperRef} className="relative min-w-0 flex-1 overflow-hidden">
          {endMarkerLeft >= 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-20 border-l-2 border-dashed"
              style={{ left: endMarkerLeft, borderColor: "var(--color-ink-muted)" }}
            >
              <span
                className="absolute left-1 rounded px-1 py-px text-[9px] font-semibold whitespace-nowrap"
                style={{
                  top: TIME_AREA_HEIGHT_PX + 3,
                  background: "var(--color-ink-muted)",
                  color: "var(--color-surface)",
                }}
              >
                End {formatMMSS(timeline.totalDurationSeconds)}
              </span>
            </div>
          )}
          <Timeline
            editorData={editorData}
            effects={effects}
            scale={SCALE_SECONDS}
            scaleWidth={scaleWidth}
            minScaleCount={minScaleCount}
            startLeft={TIMELINE_START_LEFT}
            rowHeight={ROW_HEIGHT}
            gridSnap
            dragLine
            autoScroll
            hideCursor
            onChange={handleChange}
            getActionRender={renderAction}
            getScaleRender={renderScale}
            onClickAction={(_e, { action }) => selectLoad(action.id)}
            onClickRow={handleClickRow}
            onClickTimeArea={() => {
              selectLoad(null);
              return true;
            }}
          />
        </div>
      </div>
    </div>
  );
}
