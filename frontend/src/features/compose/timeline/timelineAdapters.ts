import type { TimelineAction, TimelineEffect, TimelineRow } from "@xzdarcy/timeline-engine";
import { Load, LoadTimeline, Track, type LoadShapeKind } from "@kaigara/shared-types";
import { INSTANTANEOUS_VISUAL_SECONDS, getShapeVisual } from "./shapeVisuals";
import { trackColorLookup } from "./trackColors";

/**
 * Translates between the metamodel (Track/Load) and the shape `@xzdarcy/react-timeline-editor`
 * wants (TimelineRow/TimelineAction), in both directions.
 *
 * The library's `TimelineAction` is the only thing it hands back to our own renderers, so the
 * extra fields below (`shape`, `trackColor`, `liveState`) ride along on it untouched — see
 * `ActionRenderer.tsx`, which is where they are read.
 */

const EFFECT_IDS: LoadShapeKind[] = ["ramp", "constant", "spike", "sine", "bell", "individual"];

/** Grid the auto-grown timeline length snaps up to, so a Load dragged to 611s bumps the total to
 *  630s rather than an untidy 611s. */
const DURATION_GRID_SECONDS = 30;

/** Where a Load sits on the canvas, in seconds. Instantaneous shapes (spike/individual) carry
 *  `durationSeconds: 0` in the model, so they get a small nominal width to be clickable at all —
 *  the same window the engine spreads them over, so preview and run agree. */
function visualSpan(load: Load): { start: number; end: number } {
  const duration = load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : load.durationSeconds;
  return { start: load.startSeconds, end: load.startSeconds + duration };
}

/** How far into the run a Load is, relative to the playhead — drives the Run screen's past/active/
 *  future opacity. */
export type LiveState = "past" | "active" | "future";

/** A TimelineAction plus the fields our renderers need. Not part of the library's own type, which
 *  is why the adapters below widen into it and `ActionRenderer` narrows back out of it. */
export type LoadAction = TimelineAction & {
  shape: Load["shape"];
  trackColor: string;
  liveState?: LiveState;
};

function toAction(load: Load, trackColor: string, overrides: Partial<LoadAction> = {}): LoadAction {
  const { start, end } = visualSpan(load);
  const visual = getShapeVisual(load.shape);

  return {
    id: load.id,
    start,
    end,
    effectId: load.shape.kind,
    flexible: visual.flexible,
    movable: visual.movable,
    shape: load.shape,
    trackColor,
    ...overrides,
  };
}

/** The furthest point in time any Load on the timeline reaches, as the *model* sees it — an
 *  instantaneous shape ends where it starts, whatever width it is drawn at. */
function furthestLoadEnd(tracks: Track[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const load of track.loads) {
      end = Math.max(end, load.startSeconds + (load.shape.instantaneous ? 0 : load.durationSeconds));
    }
  }
  return end;
}

/** Returns `timeline` with `totalDurationSeconds` grown (never shrunk) to contain its furthest
 *  Load. This is the invariant the **Visual** view keeps as Loads are dragged, resized, or added
 *  past the current end — so the model's duration always reflects what's actually on the canvas.
 *
 *  The Code view deliberately does *not* call this: a hand-edited document's explicit
 *  `totalDurationSeconds` is authoritative, and a Load spilling past it is a validation warning,
 *  not something to silently paper over. */
export function coverLoads(timeline: LoadTimeline): LoadTimeline {
  const needed = Math.ceil(furthestLoadEnd(timeline.tracks) / DURATION_GRID_SECONDS) * DURATION_GRID_SECONDS;
  return needed > timeline.totalDurationSeconds ? timeline.with({ totalDurationSeconds: needed }) : timeline;
}

/** The library needs *some* effects map keyed by effectId, but nothing here relies on its `name`
 *  for rendering — `getActionRender` reads the actual LoadShape instance attached to each action
 *  instead, since a single effectId ("ramp") on its own can't tell a ramp-up from a ramp-down. */
export function buildEffects(): Record<string, TimelineEffect> {
  return Object.fromEntries(EFFECT_IDS.map((kind) => [kind, { id: kind, name: kind }]));
}

/** Editable rows for the Compose canvas. The unsaved `pendingLoad` is rendered on its own track
 *  like any other Load, but pinned in place — it is not part of the document until it is saved. */
export function toTimelineRows(
  tracks: Track[],
  selectedLoadId?: string | null,
  pendingLoad?: { trackId: string; load: Load } | null,
): TimelineRow[] {
  const colorOf = trackColorLookup(tracks);

  return tracks.map((track) => {
    const color = colorOf(track.id);
    const actions = track.loads.map((load) =>
      toAction(load, color, { selected: load.id === selectedLoadId }),
    );

    if (pendingLoad?.trackId === track.id) {
      actions.push(
        toAction(pendingLoad.load, color, {
          flexible: false,
          movable: false,
          selected: pendingLoad.load.id === selectedLoadId,
        }),
      );
    }

    return { id: track.id, actions };
  });
}

/** Read-only rows for the Run screen: nothing drags, and each action carries where it sits
 *  relative to the playhead. */
export function toRunTimelineRows(tracks: Track[], elapsedSeconds: number): TimelineRow[] {
  const colorOf = trackColorLookup(tracks);

  return tracks.map((track) => ({
    id: track.id,
    actions: track.loads.map((load) => {
      const { start, end } = visualSpan(load);
      const liveState: LiveState = end <= elapsedSeconds ? "past" : start <= elapsedSeconds ? "active" : "future";
      return toAction(load, colorOf(track.id), { flexible: false, movable: false, liveState });
    }),
  }));
}

/** Merges post-drag/resize rows back into Track[] — label/shape/requests aren't part of
 *  TimelineRow at all, so this always starts from the previous Track[] and only touches
 *  startSeconds/durationSeconds on matching Loads. */
export function applyTimelineRows(previousTracks: Track[], rows: TimelineRow[]): Track[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return previousTracks.map((track) => {
    const row = rowsById.get(track.id);
    if (!row) return track;
    const actionsById = new Map(row.actions.map((action) => [action.id, action]));

    return track.with({
      loads: track.loads.map((load) => {
        const action = actionsById.get(load.id);
        if (!action) return load;
        return load.with({
          startSeconds: action.start,
          // An instantaneous shape's width on the canvas is presentation only — its model duration
          // stays 0 however far the block was stretched.
          durationSeconds: load.shape.instantaneous ? 0 : action.end - action.start,
        });
      }),
    });
  });
}
