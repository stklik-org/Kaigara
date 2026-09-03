import type { TimelineEffect, TimelineRow } from "@xzdarcy/timeline-engine";
import { Load, LoadTimeline, Track, type LoadShapeKind } from "@kaigara/shared-types";
import { INSTANTANEOUS_VISUAL_SECONDS, getShapeVisual, resolveTrackColors } from "./shapeVisuals";

const EFFECT_IDS: LoadShapeKind[] = ["ramp", "constant", "spike", "sine", "bell", "individual"];

/** Grid the auto-grown timeline length snaps up to, so a Load dragged to 611s bumps the total to
 *  630s rather than an untidy 611s. */
const DURATION_GRID_SECONDS = 30;

/** The furthest point in time any Load on the timeline reaches. Instantaneous shapes
 *  (spike/individual) are pinned to `durationSeconds: 0` in the model, so their end is just their
 *  start — the 6s visual width they get on the canvas is presentation only. */
function furthestLoadEnd(tracks: Track[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const load of track.loads) {
      const loadEnd = load.startSeconds + (load.shape.instantaneous ? 0 : load.durationSeconds);
      if (loadEnd > end) end = loadEnd;
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
 *  for rendering — getActionRender reads the actual LoadShape instance attached to each action
 *  (see the `shape` field below) instead, since a single effectId ("ramp") on its own can't tell
 *  a ramp-up from a ramp-down. */
export function buildEffects(): Record<string, TimelineEffect> {
  return Object.fromEntries(EFFECT_IDS.map((kind) => [kind, { id: kind, name: kind }]));
}

export function toTimelineRows(
  tracks: Track[],
  selectedLoadId?: string | null,
  pendingLoad?: { trackId: string; load: Load } | null,
): TimelineRow[] {
  const colors = resolveTrackColors(tracks);

  return tracks.map((track) => ({
    id: track.id,
    actions: [
      ...track.loads.map((load) => {
        const visual = getShapeVisual(load.shape);
        const visualDuration = load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : load.durationSeconds;
        return {
          id: load.id,
          start: load.startSeconds,
          end: load.startSeconds + visualDuration,
          effectId: load.shape.kind,
          flexible: visual.flexible,
          movable: visual.movable,
          selected: load.id === selectedLoadId,
          shape: load.shape,
          trackColor: colors.get(track.id)!,
        };
      }),
      ...(pendingLoad && pendingLoad.trackId === track.id
        ? [
            {
              id: pendingLoad.load.id,
              start: pendingLoad.load.startSeconds,
              end:
                pendingLoad.load.startSeconds +
                (pendingLoad.load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : pendingLoad.load.durationSeconds),
              effectId: pendingLoad.load.shape.kind,
              flexible: false,
              movable: false,
              selected: pendingLoad.load.id === selectedLoadId,
              shape: pendingLoad.load.shape,
              trackColor: colors.get(track.id)!,
            },
          ]
        : []),
    ],
  }));
}

export type LiveState = "past" | "active" | "future";

/** Read-only variant of toTimelineRows for the Run screen: no drag/resize (movable/flexible
 *  always false regardless of shape defaults), and each action carries an extra `liveState`
 *  field — not part of the library's own TimelineAction shape, but it travels through untouched
 *  since the library only ever hands actions back to our own getActionRender. */
export function toRunTimelineRows(tracks: Track[], elapsedSeconds: number): TimelineRow[] {
  const colors = resolveTrackColors(tracks);

  return tracks.map((track) => ({
    id: track.id,
    actions: track.loads.map((load) => {
      const visualDuration = load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : load.durationSeconds;
      const end = load.startSeconds + visualDuration;
      const liveState: LiveState = end <= elapsedSeconds ? "past" : load.startSeconds <= elapsedSeconds ? "active" : "future";

      return {
        id: load.id,
        start: load.startSeconds,
        end,
        effectId: load.shape.kind,
        flexible: false,
        movable: false,
        liveState,
        shape: load.shape,
        trackColor: colors.get(track.id)!,
      };
    }),
  }));
}

/** Merges post-drag/resize TimelineRow[] back into Track[] — label/shape/requests aren't part of
 *  TimelineRow at all, so this always starts from the previous Track[] and only touches
 *  startSeconds/durationSeconds on matching Loads. */
export function applyTimelineRows(previousTracks: Track[], rows: TimelineRow[]): Track[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return previousTracks.map((track) => {
    const row = rowsById.get(track.id);
    if (!row) return track;
    const actionsById = new Map(row.actions.map((action) => [action.id, action]));

    return new Track({
      id: track.id,
      label: track.label,
      color: track.color,
      loads: track.loads.map((load) => {
        const action = actionsById.get(load.id);
        if (!action) return load;
        return new Load({
          id: load.id,
          startSeconds: action.start,
          durationSeconds: load.shape.instantaneous ? 0 : action.end - action.start,
          shape: load.shape,
          requests: load.requests,
        });
      }),
    });
  });
}
