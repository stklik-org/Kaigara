import { LoadTimeline, Track } from "./loadTimeline.ts";

/**
 * The Track colour palette, and the rule for handing colours out.
 *
 * Colours live in the **document** (`Track.color`), not in the renderer: a timeline carries the
 * colours it was authored with, so the same document looks the same wherever it is opened, and a
 * colour the user picks and one Kaigara assigned are the same kind of value. That is why this is
 * literal hex rather than a CSS variable — a `var(--…)` reference in a portable JSON document
 * would mean nothing to anything but this app's stylesheet.
 *
 * The consequence is that a palette entry cannot re-theme with the app, so each one has to work on
 * a light *and* a dark surface. These eight are the previous per-theme palette's hues, moved to
 * the lightness closest to the original that still clears **≥3:1 contrast against both**
 * `--color-surface` values (`#ffffff` and `#1c1f24`) — the same criterion `frontend/src/index.css`
 * documented when the palette was per-theme. Blue, orange, aqua, green and red barely moved;
 * yellow, magenta and violet did, because those could not clear both surfaces where they sat.
 *
 * The order is fixed and CVD-safe by adjacency: colours are handed out in this sequence, so
 * neighbouring tracks are the ones most likely to be told apart. Don't reorder it, and don't
 * replace a value by eye — re-derive it against both surfaces.
 */
/** The two surfaces a palette entry has to stay legible on — `--color-surface` in
 *  `frontend/src/index.css`, light and dark. Exported so the rule the palette was derived under is
 *  checkable rather than merely claimed: `test/trackPalette.test.ts` asserts every entry clears
 *  3:1 against both, which is what stops a future by-eye replacement from silently regressing. */
export const TRACK_PALETTE_SURFACES = { light: "#ffffff", dark: "#1c1f24" } as const;

/** WCAG minimum contrast every palette entry holds against both surfaces. Track colours are drawn
 *  as text (the load block's label) as well as fill, so this is a legibility floor, not polish. */
export const TRACK_PALETTE_MIN_CONTRAST = 3;

export const TRACK_COLOR_PALETTE: readonly string[] = [
  "#2977d6", // blue
  "#eb6733", // orange
  "#1ba775", // aqua
  "#c68701", // yellow
  "#e46796", // magenta
  "#008500", // green
  "#6c5dc6", // violet
  "#e34b4a", // red
];

function normalize(color: string): string {
  return color.trim().toLowerCase();
}

/**
 * Fills in a colour for every track that has none, leaving the ones that do untouched.
 *
 * Colours already on the timeline are treated as taken, so an assigned colour never collides with
 * a user-picked one or with an earlier track's. Assignment walks the palette in order rather than
 * hashing the track id: the order above is the one validated for adjacency, and a document that
 * gets its colours once and keeps them has no need for the colour to be derivable from the id.
 *
 * With more tracks than palette entries, colours start repeating — deliberately, and in rotation,
 * rather than leaving the extra tracks colourless.
 */
export function assignTrackColors(tracks: Track[]): Track[] {
  const taken = new Set(tracks.map((track) => track.color).filter((c): c is string => !!c).map(normalize));
  let cursor = 0;

  return tracks.map((track) => {
    if (track.color) return track;

    let slot = -1;
    for (let step = 0; step < TRACK_COLOR_PALETTE.length; step++) {
      const candidate = (cursor + step) % TRACK_COLOR_PALETTE.length;
      if (!taken.has(normalize(TRACK_COLOR_PALETTE[candidate]))) {
        slot = candidate;
        break;
      }
    }
    // Every colour is spoken for: keep rotating rather than refusing to colour the track.
    if (slot === -1) slot = cursor % TRACK_COLOR_PALETTE.length;

    cursor = slot + 1;
    const color = TRACK_COLOR_PALETTE[slot];
    taken.add(normalize(color));
    return track.with({ color });
  });
}

/** `assignTrackColors` over a whole timeline. Returns the same instance when nothing was missing,
 *  so callers can use it on every load without invalidating referential-equality checks. */
export function withAssignedTrackColors(timeline: LoadTimeline): LoadTimeline {
  if (timeline.tracks.every((track) => !!track.color)) return timeline;
  return timeline.with({ tracks: assignTrackColors(timeline.tracks) });
}
