import {
  BellShape,
  ConstantShape,
  IndividualShape,
  INSTANTANEOUS_WINDOW_SECONDS,
  LoadShape,
  RampShape,
  SineShape,
  SpikeShape,
  type LoadShapeKind,
} from "@kaigara/shared-types";
import {
  BellGlyph,
  ConstantGlyph,
  IndividualGlyph,
  RampDownGlyph,
  RampUpGlyph,
  SineGlyph,
  SpikeGlyph,
  type Glyph,
} from "./trackGlyphs";

/** Re-exported under the timeline's own name so callers here keep reading naturally, but the value
 *  lives in the metamodel: the backend's engine compiler has to spread a Spike over the exact same
 *  window, or the overlay preview would disagree with the run it is previewing. */
export const INSTANTANEOUS_VISUAL_SECONDS = INSTANTANEOUS_WINDOW_SECONDS;

/** Rendering-only info per LoadShapeKind — everything else (label, instantaneous) comes straight
 *  off the LoadShape class instance so it can never drift from the metamodel. Ramp is special: its
 *  colour/glyph depend on `direction`, handled in {@link getShapeVisual} rather than here. */
const BASE_VISUALS: Record<
  LoadShapeKind,
  { colorVar: string; bgVar: string; Glyph: Glyph; flexible: boolean; movable: boolean }
> = {
  ramp: { colorVar: "--color-status-pass", bgVar: "--color-status-pass-bg", Glyph: RampUpGlyph, flexible: true, movable: true },
  constant: { colorVar: "--color-accent", bgVar: "--color-accent-bg", Glyph: ConstantGlyph, flexible: false, movable: false },
  spike: { colorVar: "--color-status-fail", bgVar: "--color-status-fail-bg", Glyph: SpikeGlyph, flexible: false, movable: true },
  sine: { colorVar: "--color-track-magenta", bgVar: "--color-track-magenta-bg", Glyph: SineGlyph, flexible: true, movable: true },
  bell: { colorVar: "--color-status-warn", bgVar: "--color-status-warn-bg", Glyph: BellGlyph, flexible: true, movable: true },
  individual: { colorVar: "--color-accent", bgVar: "--color-accent-bg", Glyph: IndividualGlyph, flexible: false, movable: true },
};

export interface ShapeVisual {
  label: string;
  /** Short second line shown under the label on the timeline block — the shape's key numbers (e.g.
   *  a Ramp's from/to rate), so you don't have to select a Load just to see its magnitude. */
  detail: string;
  instantaneous: boolean;
  colorVar: string;
  bgVar: string;
  Glyph: Glyph;
  flexible: boolean;
  movable: boolean;
}

/** `instanceof` (not `shape.kind === ...`): TypeScript only narrows a class hierarchy like this on
 *  `instanceof`, not on a discriminant-looking field. */
function shapeDetail(shape: LoadShape): string {
  if (shape instanceof RampShape) return `${shape.fromRatePerSec} → ${shape.toRatePerSec} req/s`;
  if (shape instanceof ConstantShape) return `${shape.ratePerSec} req/s`;
  if (shape instanceof SpikeShape) return `${shape.magnitudeRatePerSec} req/s`;
  if (shape instanceof SineShape) {
    return `${shape.baseRatePerSec} ±${shape.amplitudeRatePerSec} req/s, ${shape.direction === "rise" ? "rises" : "falls"} first`;
  }
  if (shape instanceof BellShape) return `peak ${shape.peakRatePerSec} req/s`;
  if (shape instanceof IndividualShape) return `${shape.requestCount} request${shape.requestCount === 1 ? "" : "s"}`;
  return "";
}

export function getShapeVisual(shape: LoadShape): ShapeVisual {
  const base = BASE_VISUALS[shape.kind];
  // A ramp down reads as load coming *off* the server, so it takes the fail tone and the mirrored
  // glyph — the one case where a kind's visual depends on the shape's own fields.
  const isRampDown = shape instanceof RampShape && shape.direction === "down";

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
