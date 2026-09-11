import { useEffect, useMemo, useRef, useState } from "react";
import { Timeline, type TimelineState } from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import "../compose/timeline/timeline-theme.css";
import type { Track } from "@kaigara/shared-types";
import { renderAction } from "../compose/timeline/ActionRenderer";
import { renderScale } from "../compose/timeline/ScaleRenderer";
import { buildEffects, toRunTimelineRows } from "../compose/timeline/timelineAdapters";
import {
  RUN_ROW_HEIGHT,
  SCALE_SECONDS,
  SCALE_WIDTH_DEFAULT,
  TIME_AREA_HEIGHT,
} from "../compose/timeline/timelineConstants";
import { ZoomControl } from "../compose/timeline/ZoomControl";

const effects = buildEffects();

/** A load counts as active while the playhead is inside it. The epsilon covers instantaneous
 *  shapes, whose model duration is 0 — without it they would never read as active at all. */
const INSTANT_EPSILON_SECONDS = 0.001;

function trackProgressLabel(track: Track, elapsedSeconds: number): string {
  const activeNow = track.loads.some(
    (load) =>
      load.startSeconds <= elapsedSeconds &&
      elapsedSeconds < load.startSeconds + Math.max(load.durationSeconds, INSTANT_EPSILON_SECONDS),
  );
  if (activeNow) return "active now";

  const done = track.loads.filter((load) => load.startSeconds + load.durationSeconds <= elapsedSeconds).length;
  return `${done} of ${track.loads.length} done`;
}

/** Read-only sibling of the Compose screen's TimelineView: the same track-label column beside the
 *  same <Timeline>, but driven by `elapsedSeconds` instead of by drag/resize — past/active/future
 *  opacity comes from `toRunTimelineRows`, and the playhead is the library's own native cursor
 *  moved with `TimelineState.setTime()`. */
export function RunTimelineView({ tracks, elapsedSeconds }: { tracks: Track[]; elapsedSeconds: number }) {
  const timelineRef = useRef<TimelineState>(null);
  const [scaleWidth, setScaleWidth] = useState(SCALE_WIDTH_DEFAULT);
  const editorData = useMemo(() => toRunTimelineRows(tracks, elapsedSeconds), [tracks, elapsedSeconds]);

  useEffect(() => {
    timelineRef.current?.setTime(elapsedSeconds);
  }, [elapsedSeconds]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-none items-center justify-end gap-1.5 px-2 py-1">
        <ZoomControl scaleWidth={scaleWidth} onChange={setScaleWidth} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="flex w-36 flex-none flex-col border-r border-border bg-surface"
          style={{ paddingTop: TIME_AREA_HEIGHT }}
        >
          {tracks.map((track) => (
            <div
              key={track.id}
              style={{ height: RUN_ROW_HEIGHT }}
              className="flex flex-col justify-center border-b border-border px-3"
            >
              <span className="truncate text-xs font-medium text-ink">{track.label}</span>
              <span className="truncate text-[12px] text-ink-muted">{trackProgressLabel(track, elapsedSeconds)}</span>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Timeline
            ref={timelineRef}
            editorData={editorData}
            effects={effects}
            scale={SCALE_SECONDS}
            scaleWidth={scaleWidth}
            rowHeight={RUN_ROW_HEIGHT}
            disableDrag
            getActionRender={renderAction}
            getScaleRender={renderScale}
          />
        </div>
      </div>
    </div>
  );
}
