import {
  Load,
  LoadShape,
  RampShape,
  ConstantShape,
  SpikeShape,
  SineShape,
  BellShape,
  IndividualShape,
  RequestComposition,
  Track,
  INSTANTANEOUS_WINDOW_SECONDS,
  assignTrackColors,
  type LoadShapeKind,
} from "@kaigara/shared-types";
import {
  type Glyph,
  RampUpGlyph,
  RampDownGlyph,
  SineGlyph,
  BellGlyph,
  SpikeGlyph,
  ConstantGlyph,
  IndividualGlyph,
} from "./trackGlyphs";

/** Resolves every track's color in one pass. Tracks normally carry their own `color` — the
 *  document is coloured when it is loaded and when a track is added (see the scenario store), so
 *  this is a pass-through for them. It still assigns one to any track that arrived without a
 *  colour (a track hand-written into the Code view, say), through the *same* palette rule the
 *  store uses, so a colourless track never renders as an unstyled block and never collides with
 *  a sibling. Needs the full track list to do that de-duplication, so compute it once per render
 *  and look up by id rather than re-deriving it per track. */
export function resolveTrackColors(tracks: Track[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const track of assignTrackColors(tracks)) colors.set(track.id, track.color!);
  return colors;
}

/** Converts a track color to a low-opacity background variant (≈ 18% alpha over the surface)
 *  via color-mix. Track colors are literal hex — both the palette's and the user's, see
 *  `trackPalette.ts` — but color-mix takes any CSS color, so a hand-written one works too. */
export function trackColorBg(color: string): string {
  return `color-mix(in srgb, ${color} 18%, transparent)`;
}

/** Resolves a color that may be a `var(--custom-property)` reference down to its currently
 *  computed literal hex. Needed only for `<input type="color">`'s `value`, which — unlike every
 *  other place a track color is used — can't take a CSS variable directly; an already-literal
 *  color — which every track color now is — passes through untouched. */
export function resolveToLiteralColor(color: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color);
  if (!match) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
}

/** Rendering-only info per LoadShapeKind — everything else (label, instantaneous) comes straight
 *  off the LoadShape class instance so it can never drift from the metamodel. Ramp is special:
 *  its color/glyph depend on `direction`, handled in getShapeVisual below rather than here. */
const BASE_VISUALS: Record<LoadShapeKind, { colorVar: string; bgVar: string; Glyph: Glyph; flexible: boolean; movable: boolean }> = {
  ramp: { colorVar: "--color-status-pass", bgVar: "--color-status-pass-bg", Glyph: RampUpGlyph, flexible: true, movable: true },
  constant: { colorVar: "--color-accent", bgVar: "--color-accent-bg", Glyph: ConstantGlyph, flexible: false, movable: false },
  spike: { colorVar: "--color-status-fail", bgVar: "--color-status-fail-bg", Glyph: SpikeGlyph, flexible: false, movable: true },
  sine: { colorVar: "--color-track-magenta", bgVar: "--color-track-magenta-bg", Glyph: SineGlyph, flexible: true, movable: true },
  bell: { colorVar: "--color-status-warn", bgVar: "--color-status-warn-bg", Glyph: BellGlyph, flexible: true, movable: true },
  individual: { colorVar: "--color-accent", bgVar: "--color-accent-bg", Glyph: IndividualGlyph, flexible: false, movable: true },
};

/** Re-exported under the timeline's own name so callers here keep reading naturally, but the
 *  value now lives in the metamodel: the backend's engine compiler has to spread a Spike over the
 *  exact same window, or the overlay preview would disagree with the run it is previewing. */
export const INSTANTANEOUS_VISUAL_SECONDS = INSTANTANEOUS_WINDOW_SECONDS;

export interface ShapeVisual {
  label: string;
  /** Short second line shown under the label on the timeline block — the shape's key numbers
   *  (e.g. a Ramp's from/to rate), so you don't have to select a Load just to see its magnitude. */
  detail: string;
  instantaneous: boolean;
  colorVar: string;
  bgVar: string;
  Glyph: Glyph;
  flexible: boolean;
  movable: boolean;
}

/** `instanceof` (not `shape.kind === ...`) — see InfoPanels.tsx's ShapeFields for why: TS only
 *  narrows on `instanceof` for a class hierarchy like this, not on a discriminant-looking field. */
function shapeDetail(shape: LoadShape): string {
  if (shape instanceof RampShape) return `${shape.fromRatePerSec} → ${shape.toRatePerSec} req/s`;
  if (shape instanceof ConstantShape) return `${shape.ratePerSec} req/s`;
  if (shape instanceof SpikeShape) return `${shape.magnitudeRatePerSec} req/s`;
  if (shape instanceof SineShape) return `peak ${shape.peakRatePerSec} req/s`;
  if (shape instanceof BellShape) return `peak ${shape.peakRatePerSec} req/s`;
  if (shape instanceof IndividualShape) return `${shape.requestCount} request${shape.requestCount === 1 ? "" : "s"}`;
  return "";
}

export function getShapeVisual(shape: LoadShape): ShapeVisual {
  const base = BASE_VISUALS[shape.kind];
  const isRampDown = shape.kind === "ramp" && (shape as RampShape).direction === "down";

  return {
    label: shape.label,
    detail: shapeDetail(shape),
    instantaneous: shape.instantaneous,
    colorVar: isRampDown ? "--color-status-fail" : base.colorVar,
    bgVar: isRampDown ? "--color-status-fail-bg" : base.bgVar,
    Glyph: isRampDown ? RampDownGlyph : base.Glyph,
    flexible: base.flexible,
    movable: base.movable,
  };
}

const DEFAULT_DURATION_SECONDS: Record<LoadShapeKind, number> = {
  ramp: 20,
  constant: 600,
  spike: 0,
  sine: 35,
  bell: 60,
  individual: 0,
};

export function createDefaultShape(kind: LoadShapeKind): LoadShape {
  switch (kind) {
    case "ramp":
      return RampShape.createDefault("up");
    case "constant":
      return ConstantShape.createDefault();
    case "spike":
      return SpikeShape.createDefault();
    case "sine":
      return SineShape.createDefault();
    case "bell":
      return BellShape.createDefault();
    case "individual":
      return IndividualShape.createDefault();
  }
}

/** Which LoadShapeKind a click-to-add on a given Track id creates. Falls back to "constant" for
 *  an unrecognized track id rather than throwing — this only affects what gets pre-selected for
 *  further editing. */
const DEFAULT_KIND_FOR_TRACK: Record<string, LoadShapeKind> = {
  ramp: "ramp",
  "periodic-burst": "sine",
  "peak-event": "bell",
  spike: "spike",
  "base-load": "constant",
  individual: "individual",
};

export function defaultKindForTrack(trackId: string): LoadShapeKind {
  return DEFAULT_KIND_FOR_TRACK[trackId] ?? "constant";
}

let nextLoadSuffix = 1;

/** Builds a brand-new Load of `kind` starting at `startSeconds`, using that kind's default shape
 *  and an empty RequestComposition — the click-to-add-on-a-track entry point. */
export function createLoad(kind: LoadShapeKind, startSeconds: number): Load {
  const shape = createDefaultShape(kind);
  return new Load({
    id: `${kind}-new-${Date.now()}-${nextLoadSuffix++}`,
    startSeconds: Math.max(0, Math.round(startSeconds)),
    durationSeconds: shape.instantaneous ? 0 : DEFAULT_DURATION_SECONDS[kind],
    shape,
    requests: RequestComposition.empty(),
  });
}
