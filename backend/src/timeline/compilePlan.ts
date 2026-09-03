/**
 * Lowers an authored `LoadTimeline` into the engine-neutral `ExecutionPlan`.
 *
 * This is the "translate the compose view into actual requests" step. Two things happen:
 *
 *  1. **Shape → rate curve.** Every `LoadShape` already knows its own instantaneous rate via
 *     `rateAt(elapsed, duration)`; this module samples that into a piecewise-linear profile the
 *     engine can execute. Sampling the metamodel's own function (rather than re-deriving each
 *     curve here) is what keeps the Compose screen's "expected requests" overlay and the actual
 *     run in agreement — both read the same `rateAt`.
 *
 *  2. **RequestComposition → HTTP.** Each `RequestSpec` becomes a concrete IDTA-01002 call (see
 *     `aasOperations.ts`) with its weight folded into a cumulative distribution, so the engine
 *     picks one with a single random draw instead of summing weights per iteration.
 */

import {
  INSTANTANEOUS_WINDOW_SECONDS,
  IndividualShape,
  LoadTimeline,
  collectLoadTimelineIssues,
  hasErrors,
  TimelineValidationError,
  type Load,
  type LoadTimelineData,
  type RequestComposition,
  type ValidationIssue,
} from "@kaigara/shared-types";

import { describeOperation } from "./aasOperations.ts";
import type {
  ExecutionPlan,
  PlanTarget,
  PlannedBody,
  PlannedExecution,
  PlannedLoad,
  PlannedRequest,
  RateProfile,
  RateSegment,
} from "./executionPlan.ts";

/**
 * How many linear segments a curved shape (sine, bell) is approximated with. Piecewise-linear
 * error falls off as 1/n²; at 16 segments a half-sine is reproduced to well under a percent,
 * which is far below the run-to-run variance of the thing being measured. Raising it mainly costs
 * engine-config size.
 */
const CURVE_SEGMENTS = 16;

/** Ramps are already linear, so one segment reproduces them exactly. */
const LINEAR_SHAPE_KINDS = new Set(["ramp", "constant"]);

export interface CompileOptions {
  scenarioName?: string;
  target: PlanTarget;
}

export interface CompileResult {
  plan: ExecutionPlan;
  /** Non-blocking issues found while validating the source document, forwarded so the caller can
   *  show the user *why* a run may not do what they expect (a load that sends nothing, a load
   *  scheduled past the end of the timeline). */
  warnings: ValidationIssue[];
}

/** Engine scenario keys and metric tags have to survive shell quoting, JS identifiers and file
 *  names; authored ids are free-form strings, so they get folded down here. Uniqueness is
 *  guaranteed by the caller appending an index, not by this function. */
function sanitiseKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "load";
}

/**
 * Samples `shape.rateAt()` across the load's effective window into a piecewise-linear profile.
 *
 * Instantaneous shapes (spike, individual) carry `durationSeconds: 0` in the authoring model, so
 * they are spread over `INSTANTANEOUS_WINDOW_SECONDS` — the same constant the Compose overlay
 * uses, which is why the preview and the run agree on how many requests a Spike represents.
 */
function sampleRateProfile(load: Load): RateProfile {
  const instantaneous = load.shape.instantaneous;
  const durationSeconds = instantaneous ? INSTANTANEOUS_WINDOW_SECONDS : load.durationSeconds;

  if (durationSeconds <= 0) {
    return { startRatePerSec: 0, segments: [], peakRatePerSec: 0, durationSeconds: 0, flat: true };
  }

  const segmentCount = LINEAR_SHAPE_KINDS.has(load.shape.kind) ? 1 : CURVE_SEGMENTS;
  const step = durationSeconds / segmentCount;

  const startRatePerSec = load.shape.rateAt(0, durationSeconds);
  const segments: RateSegment[] = [];
  let peakRatePerSec = startRatePerSec;

  for (let i = 1; i <= segmentCount; i++) {
    const toRatePerSec = load.shape.rateAt(i * step, durationSeconds);
    segments.push({ durationSeconds: step, toRatePerSec });
    if (toRatePerSec > peakRatePerSec) peakRatePerSec = toRatePerSec;
  }

  const flat = segments.every((segment) => segment.toRatePerSec === startRatePerSec);

  return { startRatePerSec, segments, peakRatePerSec, durationSeconds, flat };
}

/** Area under the piecewise-linear curve — the request count the plan expects to issue. */
function integrateProfile(profile: RateProfile): number {
  let total = 0;
  let previous = profile.startRatePerSec;
  for (const segment of profile.segments) {
    total += ((previous + segment.toRatePerSec) / 2) * segment.durationSeconds;
    previous = segment.toRatePerSec;
  }
  return total;
}

function planExecution(load: Load): PlannedExecution {
  // "Individual" is a literal count of requests, not a rate — a rate curve cannot express "send
  // exactly three", and rounding one into existence would make the run non-reproducible.
  // `instanceof`, not a `kind` comparison — TypeScript narrows a class hierarchy on the former
  // only, and the rest of the codebase reads shape fields the same way (see shapeVisuals.ts).
  if (load.shape instanceof IndividualShape) {
    const iterations = Math.max(0, Math.round(load.shape.requestCount));
    return { mode: "fixed", iterations, withinSeconds: INSTANTANEOUS_WINDOW_SECONDS };
  }
  return { mode: "rate", profile: sampleRateProfile(load) };
}

function planBody(spec: RequestComposition["requests"][number], sendsBody: boolean): PlannedBody {
  if (!sendsBody) return { kind: "none" };

  const generator = spec.generator.toJSON();
  switch (generator.kind) {
    case "randomized":
      return { kind: "randomized", sizeBytes: generator.sizeBytes };
    case "exact":
      return { kind: "exact", value: generator.value };
    case "mutate":
      return { kind: "mutate", baseValue: generator.baseValue, mutationRatePercent: generator.mutationRatePercent };
    default: {
      const unreachable: never = generator;
      throw new Error(`Unknown generator ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Folds authored weights into a cumulative distribution over [0,1].
 *
 * Weights are relative and need not sum to anything in particular (the authoring model says so
 * explicitly), so they are normalised here. A composition whose weights are all zero would
 * otherwise divide by zero; it is treated as uniform, and the validator has already warned the
 * user that nothing could be selected.
 */
function planRequests(composition: RequestComposition): PlannedRequest[] {
  const specs = composition.requests;
  if (specs.length === 0) return [];

  const totalWeight = specs.reduce((sum, spec) => sum + spec.weight, 0);
  const uniform = totalWeight <= 0;
  const effectiveTotal = uniform ? specs.length : totalWeight;

  let cumulative = 0;
  return specs.map((spec, index) => {
    const descriptor = describeOperation(spec.operation, spec.target);
    cumulative += uniform ? 1 : spec.weight;

    return {
      id: spec.id,
      operation: spec.operation,
      target: spec.target,
      weight: spec.weight,
      // Pin the last entry to exactly 1 so floating-point drift can never leave a sliver of the
      // [0,1) draw unmatched.
      cumulativeWeight: index === specs.length - 1 ? 1 : cumulative / effectiveTotal,
      method: descriptor.method,
      pathTemplate: descriptor.pathTemplate,
      query: descriptor.query,
      idSource: descriptor.idSource,
      consumesId: descriptor.consumesId,
      body: planBody(spec, descriptor.sendsBody),
      expectStatus: descriptor.expectStatus,
    } satisfies PlannedRequest;
  });
}

function describeShape(load: Load): string {
  const shape = load.shape as unknown as Record<string, number | string>;
  switch (load.shape.kind) {
    case "ramp":
      return `${load.shape.label} ${shape.fromRatePerSec}→${shape.toRatePerSec} req/s`;
    case "constant":
      return `Constant ${shape.ratePerSec} req/s`;
    case "spike":
      return `Spike ${shape.magnitudeRatePerSec} req/s`;
    case "sine":
    case "bell":
      return `${load.shape.label} peak ${shape.peakRatePerSec} req/s`;
    case "individual":
      return `${shape.requestCount} individual request(s)`;
    default:
      return load.shape.label;
  }
}

/**
 * Validates and compiles a timeline document.
 *
 * @throws {TimelineValidationError} if the document has any error-severity issue — the backend
 * must never compile an unvalidated document into an engine script, since a `NaN` rate or a
 * missing `startSeconds` would surface as an incomprehensible engine failure much later.
 */
export function compilePlan(input: LoadTimelineData | LoadTimeline, options: CompileOptions): CompileResult {
  const data: LoadTimelineData = input instanceof LoadTimeline ? input.toJSON() : input;

  const issues = collectLoadTimelineIssues(data);
  if (hasErrors(issues)) throw new TimelineValidationError(issues);

  const timeline = LoadTimeline.fromJSON(data);
  const loads: PlannedLoad[] = [];
  let expectedRequests = 0;

  timeline.tracks.forEach((track) => {
    track.loads.forEach((load, index) => {
      const requests = planRequests(load.requests);
      const execution = planExecution(load);

      // A load with no requests would compile into an engine scenario that starts a worker, picks
      // nothing, and exits — pure overhead competing with the load being measured (proposal
      // section 2.3). The validator has already warned; drop it from the plan.
      if (requests.length === 0) return;

      expectedRequests +=
        execution.mode === "fixed" ? execution.iterations : integrateProfile(execution.profile);

      loads.push({
        key: `${sanitiseKey(track.id)}__${sanitiseKey(load.id)}__${index}`,
        loadId: load.id,
        trackId: track.id,
        trackLabel: track.label,
        label: `${track.label} · ${describeShape(load)}`,
        shapeKind: load.shape.kind,
        startSeconds: load.startSeconds,
        execution,
        requests,
      });
    });
  });

  const plan: ExecutionPlan = {
    version: 1,
    scenarioName: options.scenarioName?.trim() || "untitled-scenario",
    target: options.target,
    totalDurationSeconds: timeline.totalDurationSeconds,
    loads,
    expectedRequests: Math.round(expectedRequests),
  };

  return { plan, warnings: issues.filter((issue) => issue.severity === "warning") };
}
