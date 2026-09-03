/**
 * The polymorphic part of the metamodel: a Load's shape determines its request-rate curve over
 * time. Each kind is a concrete class so the timeline/overlay-chart code can call `rateAt()`
 * polymorphically instead of switching on a kind string — see
 * frontend/src/features/compose/overlay/computeRateCurve.ts.
 */
export type LoadShapeKind = "ramp" | "constant" | "spike" | "sine" | "bell" | "individual";

/**
 * The nominal window an instantaneous shape (Spike, Individual) is spread over.
 *
 * These shapes carry `durationSeconds: 0` in the data model, but neither a chart nor a load
 * generator can do anything with a zero-width interval — both need *some* window to turn a
 * magnitude into requests. Keeping the number here, rather than one copy in the frontend's
 * overlay chart and another in the backend's engine compiler, is what makes the "expected
 * requests" preview on the Compose screen agree with what the engine actually issues.
 */
export const INSTANTANEOUS_WINDOW_SECONDS = 6;

export interface RampShapeData {
  kind: "ramp";
  direction: "up" | "down";
  fromRatePerSec: number;
  toRatePerSec: number;
}

export interface ConstantShapeData {
  kind: "constant";
  ratePerSec: number;
}

export interface SpikeShapeData {
  kind: "spike";
  magnitudeRatePerSec: number;
}

export interface SineShapeData {
  kind: "sine";
  peakRatePerSec: number;
}

export interface BellShapeData {
  kind: "bell";
  peakRatePerSec: number;
}

/** Not a rate at all — a fixed number of literal requests fired once (e.g. "create one shell
 *  here to test a downstream trigger"), distinct from Spike's synthetic rate-burst. */
export interface IndividualShapeData {
  kind: "individual";
  requestCount: number;
}

export type LoadShapeData =
  | RampShapeData
  | ConstantShapeData
  | SpikeShapeData
  | SineShapeData
  | BellShapeData
  | IndividualShapeData;

function clampFraction(elapsedSeconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, elapsedSeconds / durationSeconds));
}

export abstract class LoadShape {
  abstract readonly kind: LoadShapeKind;
  abstract readonly label: string;
  /** Instantaneous shapes (Spike, Individual) fire once rather than sustaining a rate across
   *  [0, durationSeconds] — callers that need to *display* them still give them a small nominal
   *  visual width (see INSTANTANEOUS_VISUAL_SECONDS in the frontend), but the data model itself
   *  always has durationSeconds 0 for these. */
  abstract readonly instantaneous: boolean;
  /** Approximate request rate (req/s) at `elapsedSeconds` into a Load of this shape lasting
   *  `durationSeconds` in total — the input to the Compose "expected requests overlay" preview. */
  abstract rateAt(elapsedSeconds: number, durationSeconds: number): number;
  abstract toJSON(): LoadShapeData;

  static fromJSON(data: LoadShapeData): LoadShape {
    switch (data.kind) {
      case "ramp":
        return new RampShape(data);
      case "constant":
        return new ConstantShape(data);
      case "spike":
        return new SpikeShape(data);
      case "sine":
        return new SineShape(data);
      case "bell":
        return new BellShape(data);
      case "individual":
        return new IndividualShape(data);
      default: {
        // Exhaustiveness guard: TS considers the switch above complete for the LoadShapeData
        // union, but untrusted input (e.g. a hand-edited JSON document) can still carry a
        // `kind` outside it at runtime — fail loudly here rather than silently returning
        // undefined further down the call chain.
        const unreachable: never = data;
        throw new Error(`Unknown LoadShape kind: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

export class RampShape extends LoadShape {
  readonly kind = "ramp" as const;
  readonly instantaneous = false;
  readonly label: string;
  direction: "up" | "down";
  fromRatePerSec: number;
  toRatePerSec: number;

  constructor(data: Omit<RampShapeData, "kind">) {
    super();
    this.direction = data.direction;
    this.fromRatePerSec = data.fromRatePerSec;
    this.toRatePerSec = data.toRatePerSec;
    this.label = data.direction === "up" ? "Ramp up" : "Ramp down";
  }

  rateAt(elapsedSeconds: number, durationSeconds: number): number {
    const frac = clampFraction(elapsedSeconds, durationSeconds);
    return this.fromRatePerSec + (this.toRatePerSec - this.fromRatePerSec) * frac;
  }

  toJSON(): RampShapeData {
    return { kind: "ramp", direction: this.direction, fromRatePerSec: this.fromRatePerSec, toRatePerSec: this.toRatePerSec };
  }

  static createDefault(direction: "up" | "down" = "up"): RampShape {
    return direction === "up"
      ? new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 380 })
      : new RampShape({ direction: "down", fromRatePerSec: 380, toRatePerSec: 0 });
  }
}

export class ConstantShape extends LoadShape {
  readonly kind = "constant" as const;
  readonly instantaneous = false;
  readonly label = "Constant";
  ratePerSec: number;

  constructor(data: Omit<ConstantShapeData, "kind">) {
    super();
    this.ratePerSec = data.ratePerSec;
  }

  rateAt(): number {
    return this.ratePerSec;
  }

  toJSON(): ConstantShapeData {
    return { kind: "constant", ratePerSec: this.ratePerSec };
  }

  static createDefault(): ConstantShape {
    return new ConstantShape({ ratePerSec: 100 });
  }
}

export class SpikeShape extends LoadShape {
  readonly kind = "spike" as const;
  readonly instantaneous = true;
  readonly label = "Spike";
  magnitudeRatePerSec: number;

  constructor(data: Omit<SpikeShapeData, "kind">) {
    super();
    this.magnitudeRatePerSec = data.magnitudeRatePerSec;
  }

  rateAt(): number {
    return this.magnitudeRatePerSec;
  }

  toJSON(): SpikeShapeData {
    return { kind: "spike", magnitudeRatePerSec: this.magnitudeRatePerSec };
  }

  static createDefault(): SpikeShape {
    return new SpikeShape({ magnitudeRatePerSec: 250 });
  }
}

/** A single half-sine hump across the Load's own duration — periodicity comes from placing
 *  several Sine Loads spaced out on the same Track, not from oscillating within one Load. */
export class SineShape extends LoadShape {
  readonly kind = "sine" as const;
  readonly instantaneous = false;
  readonly label = "Sine";
  peakRatePerSec: number;

  constructor(data: Omit<SineShapeData, "kind">) {
    super();
    this.peakRatePerSec = data.peakRatePerSec;
  }

  rateAt(elapsedSeconds: number, durationSeconds: number): number {
    const frac = clampFraction(elapsedSeconds, durationSeconds);
    return this.peakRatePerSec * Math.sin(Math.PI * frac);
  }

  toJSON(): SineShapeData {
    return { kind: "sine", peakRatePerSec: this.peakRatePerSec };
  }

  static createDefault(): SineShape {
    return new SineShape({ peakRatePerSec: 300 });
  }
}

/** A narrower Gaussian hump than Sine — for a single one-time peak event rather than a shape
 *  meant to recur. */
export class BellShape extends LoadShape {
  readonly kind = "bell" as const;
  readonly instantaneous = false;
  readonly label = "Bell";
  peakRatePerSec: number;

  constructor(data: Omit<BellShapeData, "kind">) {
    super();
    this.peakRatePerSec = data.peakRatePerSec;
  }

  rateAt(elapsedSeconds: number, durationSeconds: number): number {
    const frac = clampFraction(elapsedSeconds, durationSeconds);
    const sigma = 0.15;
    return this.peakRatePerSec * Math.exp(-((frac - 0.5) ** 2) / (2 * sigma * sigma));
  }

  toJSON(): BellShapeData {
    return { kind: "bell", peakRatePerSec: this.peakRatePerSec };
  }

  static createDefault(): BellShape {
    return new BellShape({ peakRatePerSec: 400 });
  }
}

export class IndividualShape extends LoadShape {
  readonly kind = "individual" as const;
  readonly instantaneous = true;
  readonly label = "Individual";
  requestCount: number;

  constructor(data: Omit<IndividualShapeData, "kind">) {
    super();
    this.requestCount = data.requestCount;
  }

  /** Spreads the discrete request count evenly across whatever visual window the caller passes
   *  as `durationSeconds` (see INSTANTANEOUS_VISUAL_SECONDS) to get an equivalent req/s for the
   *  overlay chart — there's no real "rate" for a one-off injection. */
  rateAt(_elapsedSeconds: number, durationSeconds: number): number {
    return this.requestCount / Math.max(durationSeconds, 1);
  }

  toJSON(): IndividualShapeData {
    return { kind: "individual", requestCount: this.requestCount };
  }

  static createDefault(): IndividualShape {
    return new IndividualShape({ requestCount: 1 });
  }
}
