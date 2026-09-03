import type { Load, Track } from "@kaigara/shared-types";
import { INSTANTANEOUS_VISUAL_SECONDS, resolveTrackColors } from "../timeline/shapeVisuals";

const SAMPLE_COUNT = 120;

export interface TrackRateCurve {
  trackId: string;
  label: string;
  /** Hex color string resolved from the track's own color or the palette fallback. */
  color: string;
  /** req/s contribution from this track alone, sampled evenly across [0, totalDurationSeconds]. */
  values: number[];
}

/** Delegates to the Load's own LoadShape.rateAt() — this is the payoff of LoadShape being a real
 *  class hierarchy rather than a kind string + config bag: no per-kind switch needed here at all
 *  anymore. Still just a preview, not a promise of exactly what k6 would generate (see the
 *  "compiled to a manual ramping-arrival-rate stage sequence" note on the wireframe's Load
 *  Composer panel). */
function loadRateAt(load: Load, t: number): number {
  const effectiveDuration = load.shape.instantaneous ? INSTANTANEOUS_VISUAL_SECONDS : load.durationSeconds;
  const elapsed = t - load.startSeconds;
  if (elapsed < 0 || elapsed > effectiveDuration) return 0;
  return load.shape.rateAt(elapsed, effectiveDuration);
}

export function computeTrackRateCurves(tracks: Track[], totalDurationSeconds: number): TrackRateCurve[] {
  const dt = totalDurationSeconds / SAMPLE_COUNT;
  const colors = resolveTrackColors(tracks);

  return tracks.map((track) => ({
    trackId: track.id,
    label: track.label,
    color: colors.get(track.id)!,
    values: Array.from({ length: SAMPLE_COUNT + 1 }, (_, i) => {
      const t = i * dt;
      return track.loads.reduce((sum, load) => sum + loadRateAt(load, t), 0);
    }),
  }));
}
