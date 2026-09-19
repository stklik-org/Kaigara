import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Timeline } from "@xzdarcy/react-timeline-editor";
import type { TimelineRow } from "@xzdarcy/timeline-engine";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import "./timeline-theme.css";
import { useScenarioStore } from "../store/scenarioStore";
import { applyTimelineRows, buildEffects, coverLoads, toTimelineRows } from "./timelineAdapters";
import { renderAction } from "./ActionRenderer";
import { renderScale } from "./ScaleRenderer";
import { createLoad, defaultKindForTrack } from "./modelFactories";
import { formatMMSS } from "./formatTime";
import { useMMSSDraft } from "./useMMSSDraft";
import { TrackLabelSidebar } from "./TrackLabelSidebar";
import { ZoomControl } from "./ZoomControl";
import { ExchangeCaptureField } from "./ExchangeCaptureField";
import {
  ROW_HEIGHT,
  SCALE_SECONDS,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  TIMELINE_START_LEFT,
  TIME_AREA_HEIGHT,
} from "./timelineConstants";

/** Grid that dragging, resizing and the Total length field all snap to. */
const SNAP_SECONDS = 5;
/** Floor for "Total length" — a timeline shorter than a single major tick (one minute) isn't a
 *  meaningful thing to compose against. */
const MIN_TOTAL_SECONDS = SCALE_SECONDS;
/** How far an arrow key nudges the track-name column, px. */
const SIDEBAR_KEYBOARD_STEP = 12;
/** The library virtualizes rows/actions via react-virtualized, whose actual scrolling DOM node
 *  lives at this selector — not part of any public API, so this is somewhat brittle across library
 *  upgrades, but it is the only way to mirror horizontal scroll onto the overlay chart and
 *  vertical scroll onto the sidebar (there is no onScroll prop on either axis). */
const SCROLL_GRID_SELECTOR = ".timeline-editor-edit-area .ReactVirtualized__Grid";

const effects = buildEffects();

const clampSidebarWidth = (width: number) => Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, width));

export interface ScrollMetrics {
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}

/** The toolbar's "Total length" field, bound to `LoadTimeline.totalDurationSeconds`. Commits on
 *  blur/Enter, snapped to the drag grid and clamped to one tick minimum. Dragging or adding a Load
 *  past this value grows it back automatically (see `coverLoads`). */
function TotalLengthField() {
  const totalDurationSeconds = useScenarioStore((s) => s.timeline.totalDurationSeconds);
  const setTotalDuration = useScenarioStore((s) => s.setTotalDuration);
  const draft = useMMSSDraft(totalDurationSeconds, setTotalDuration, (seconds) =>
    Math.max(MIN_TOTAL_SECONDS, Math.round(seconds / SNAP_SECONDS) * SNAP_SECONDS),
  );

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
      <span>Total scenario length</span>
      <input
        {...draft}
        className="w-16 rounded border border-border-strong bg-transparent px-1.5 py-0.5 text-center font-mono text-ink outline-none focus:border-accent"
        title="Total timeline length (m:ss) — Loads placed past this grow it automatically"
      />
    </label>
  );
}

/** The draggable seam between the track-name column and the grid. Overlaid on the boundary so it
 *  takes no layout width, which is what keeps the grid and the overlay chart's plot starting at
 *  the same x. */
function SidebarResizeHandle({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  function begin(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    onChange(clampSidebarWidth(drag.current.startWidth + (e.clientX - drag.current.startX)));
  }

  function end(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize track name column"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onChange(clampSidebarWidth(width + (e.key === "ArrowLeft" ? -1 : 1) * SIDEBAR_KEYBOARD_STEP));
      }}
      style={{ left: width }}
      className="group absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none focus-visible:outline-none"
    >
      {/* Sits exactly on the seam (the sidebar's own border-r is the resting line); a 2px accent
          bar fades in on hover/focus. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}

/** Wraps <Timeline> from `@xzdarcy/react-timeline-editor`. The library has no concept of a track
 *  label column, so TrackLabelSidebar renders our own, kept in sync purely by using the same
 *  rowHeight for both. Vertical scroll from the library's virtualized grid is mirrored onto the
 *  sidebar imperatively — no state, no re-render. Horizontal scroll and zoom are lifted to
 *  ComposePage so the Expected Requests overlay can share them.
 *
 *  `height` is the pixel height ComposePage's splitter has allotted this panel; the library
 *  virtualizes rows, so a short height shows fewer tracks with an internal scrollbar rather than
 *  clipping. */
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
  onScrollMetricsChange: (metrics: ScrollMetrics) => void;
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
  const lastMetricsRef = useRef<ScrollMetrics | null>(null);
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
    let rafId = 0;

    function handleScroll() {
      if (!gridEl) return;
      const metrics: ScrollMetrics = {
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
      // Mirror vertical scroll straight onto the sidebar's rows container — an imperative DOM
      // write avoids a React state round-trip and keeps the two halves pixel-locked.
      if (sidebarScrollRef.current) sidebarScrollRef.current.scrollTop = gridEl.scrollTop;
    }

    // The grid node is created by the library, so it may not exist on the first frame.
    function attach() {
      gridEl = wrapper!.querySelector(SCROLL_GRID_SELECTOR);
      if (!gridEl) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      gridEl.addEventListener("scroll", handleScroll);
      handleScroll();
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

  function handleClickRow(e: MouseEvent, { row, time }: { row: TimelineRow; time: number }) {
    // The library's row click handler doesn't stop propagation, so clicking (or dragging) an
    // existing action bubbles up here too — without this guard every select/drag would also add a
    // brand-new Load underneath it. Only genuinely empty row background should add one.
    if ((e.target as HTMLElement).closest(".timeline-editor-action")) return;

    const load = createLoad(defaultKindForTrack(row.id), Math.round(time / SNAP_SECONDS) * SNAP_SECONDS);
    stageLoad(row.id, load);
    selectLoad(load.id);
  }

  // The library sizes its scrollable extent to the furthest action (plus headroom) but never below
  // `minScaleCount` ticks — so pinning that to the model's total length makes the rendered timeline
  // exactly as long as `totalDurationSeconds` whenever nothing hangs past it. `maxScaleCount` is
  // left unbounded so a Load can still be dragged out past the end (coverLoads then bumps the
  // total to match on drop).
  const minScaleCount = Math.max(1, Math.ceil(timeline.totalDurationSeconds / SCALE_SECONDS));

  // x (px, relative to the <Timeline> wrapper) of the totalDurationSeconds gridline, following the
  // library's own time→pixel mapping, minus how far the grid is scrolled. Hidden once it scrolls
  // off the left edge so it can't paint over the track-label sidebar.
  const endMarkerLeft =
    TIMELINE_START_LEFT + (timeline.totalDurationSeconds / SCALE_SECONDS) * scaleWidth - scrollLeft;

  return (
    <div className="flex w-full flex-col" style={{ height }}>
      <div className="flex flex-none items-center justify-between gap-3 px-2 py-1">
        <div className="flex items-center gap-5">
          <TotalLengthField />
          <ExchangeCaptureField />
        </div>
        <ZoomControl scaleWidth={scaleWidth} onChange={onScaleWidthChange} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <TrackLabelSidebar
          tracks={timeline.tracks}
          rowHeight={ROW_HEIGHT}
          timeAreaHeight={TIME_AREA_HEIGHT}
          scrollRef={sidebarScrollRef}
          width={sidebarWidth}
        />
        <SidebarResizeHandle width={sidebarWidth} onChange={onSidebarWidthChange} />
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
                  top: TIME_AREA_HEIGHT + 3,
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
