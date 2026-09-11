import { TRACK_COLOR_PALETTE, assignTrackColors, type Track } from "@kaigara/shared-types";

/**
 * Resolves every track's colour in one pass and hands back a lookup.
 *
 * Tracks normally carry their own `color` — the document is coloured when it is loaded and when a
 * track is added (see `store/scenarioStore.ts`), so this is a pass-through for them. It still
 * assigns one to any track that arrived without a colour (a track hand-written into the Code view,
 * say) through the *same* palette rule the store uses, so a colourless track never renders as an
 * unstyled block and never collides with a sibling.
 *
 * De-duplication needs the whole track list, so this is computed once per render and looked up by
 * id rather than re-derived per track.
 */
export function trackColorLookup(tracks: Track[]): (trackId: string) => string {
  const colors = new Map<string, string>();
  for (const track of assignTrackColors(tracks)) {
    // `assignTrackColors` colours every track it returns; the fallback only covers a lookup for an
    // id that is not on this list at all, which would otherwise render as an unstyled block.
    colors.set(track.id, track.color ?? TRACK_COLOR_PALETTE[0]);
  }
  return (trackId) => colors.get(trackId) ?? TRACK_COLOR_PALETTE[0];
}

/** Converts a track colour to a low-opacity background variant (≈ 18% alpha over the surface) via
 *  `color-mix`. Track colours are literal hex — both the palette's and the user's, see
 *  `trackPalette.ts` — but `color-mix` takes any CSS colour, so a hand-written one works too. */
export function trackColorBg(color: string): string {
  return `color-mix(in srgb, ${color} 18%, transparent)`;
}

/** Same tint, but mixed against `--color-surface` instead of `transparent` — fully opaque rather
 *  than ≈18% alpha. `renderAction` uses this only for the icon+label chip, not the Load's own
 *  background: when a hovered Load is brought in front of an overlapping neighbour (see
 *  timeline-theme.css's `.timeline-editor-action:hover`), the translucent Load background alone
 *  would still let that neighbour show through underneath the text. The chip needs to fully
 *  occlude it to stay legible. */
export function trackColorChipBg(color: string): string {
  return `color-mix(in srgb, ${color} 18%, var(--color-surface))`;
}
