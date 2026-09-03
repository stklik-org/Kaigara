import type { Load, LoadTimeline, Track } from "@kaigara/shared-types";

export interface FoundLoad {
  track: Track;
  load: Load;
  pending: boolean;
}

export function findLoad(
  timeline: LoadTimeline,
  loadId: string | null,
  pendingLoad?: { trackId: string; load: Load } | null,
): FoundLoad | null {
  if (pendingLoad?.load.id === loadId) {
    const track = timeline.tracks.find((t) => t.id === pendingLoad.trackId);
    if (track) return { track, load: pendingLoad.load, pending: true };
  }
  for (const track of timeline.tracks) {
    const load = track.loads.find((l) => l.id === loadId);
    if (load) return { track, load, pending: false };
  }
  return null;
}
