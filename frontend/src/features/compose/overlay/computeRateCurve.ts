import type { Load, Track } from "@kaigara/shared-types";
import { INSTANTANEOUS_VISUAL_SECONDS } from "../timeline/shapeVisuals";
import { trackColorLookup } from "../timeline/trackColors";

/** How many points each curve is sampled at across the whole timeline. Fixed rather than
 *  per-second: the chart is a shape preview, and a constant sample count keeps redraw cost flat
 *  however long the scenario is. */
const SAMPLE_COUNT = 120;

export interface TrackRateCurve {
  trackId: string;
  label: string;
  /** Literal colour resolved from the track's own or the palette fallback. */
  color: string;
  /** req/s contribution from this track alone, sampled evenly across [0, totalDurationSeconds]. */
  values: number[];
}

/** Delegates to the Load's own `LoadShape.rateAt()` — the payoff of LoadShape being a real class
 *  hierarchy rather than a kind string plus a config bag: no per-kind switch is needed here at
 *  all. Still a preview, not a promise of exactly what k6 will generate. */
function loadRateAt(load: Load, t: number): number {
  const effectiveDuration = load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : load.durationSeconds;
  const elapsed = t - load.startSeconds;
  if (elapsed < 0 || elapsed > effectiveDuration) return 0;
  return load.shape.rateAt(elapsed, effectiveDuration);
}

export function computeTrackRateCurves(tracks: Track[], totalDurationSeconds: number): TrackRateCurve[] {
  const dt = totalDurationSeconds / SAMPLE_COUNT;
  const colorOf = trackColorLookup(tracks);

  return tracks.map((track) => ({
    trackId: track.id,
    label: track.label,
    color: colorOf(track.id),
    values: Array.from({ length: SAMPLE_COUNT + 1 }, (_, i) =>
      track.loads.reduce((sum, load) => sum + loadRateAt(load, i * dt), 0),
    ),
  }));
}
