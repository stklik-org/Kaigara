/**
 * The engine-neutral intermediate representation between a `LoadTimeline` and a concrete load
 * generator.
 *
 * ADR 0001 requires that no engine-specific field leaks into `Recipe`/`RunState`/`RunAnalysis`,
 * and that the "compile → run → parse" step sits behind a stable `EngineAdapter` seam. This
 * module is the input side of that seam: `compilePlan.ts` lowers the authored timeline into the
 * vocabulary every load generator shares — *when* to start, *what rate* to hold, and *which HTTP
 * request* to issue — and the adapter renders that into k6 stages, or Gatling injection steps, or
 * whatever comes next. Nothing here mentions k6.
 *
 * It is deliberately a separate type from `LoadTimelineData` rather than an annotated version of
 * it: the timeline is an *authoring* model (shapes, tracks, colours) and this is an *execution*
 * model (flat list of things to run, absolute rates, resolved URLs). Collapsing the two would put
 * engine concerns back into the document the user edits.
 */

import type { RequestOperation, RequestTargetEntity } from "@kaigara/shared-types";

/** Where the load is aimed. Resolved from the connection at plan time so the engine never has to
 *  know about Kaigara's connection store. */
export interface PlanTarget {
  /** API root, no trailing slash, e.g. "http://localhost:8081/api/v3". */
  baseUrl: string;
  /** Per-request timeout handed to the engine. */
  timeoutSeconds: number;
  /** Extra headers applied to every request (auth would land here once it exists). */
  headers: Record<string, string>;
}

/**
 * One leg of a piecewise-linear rate curve: ramp linearly from the previous segment's rate (or
 * the profile's `startRatePerSec` for the first) to `toRatePerSec`, over `durationSeconds`.
 *
 * Every non-linear shape (sine, bell) is approximated by a run of these — see `sampleRateProfile`.
 * Chosen because it is the lowest common denominator across engines: k6's `stages`, Gatling's
 * `rampUsersPerSec`, and Locust's `LoadTestShape` all express exactly this.
 */
export interface RateSegment {
  durationSeconds: number;
  toRatePerSec: number;
}

export interface RateProfile {
  startRatePerSec: number;
  segments: RateSegment[];
  /** Peak of the curve — engines need it to size their worker/VU pool up front. */
  peakRatePerSec: number;
  /** Total span of `segments`; may exceed the Load's authored duration for instantaneous shapes,
   *  which are spread over INSTANTANEOUS_WINDOW_SECONDS. */
  durationSeconds: number;
  /** True when the profile is a single flat segment, letting an adapter pick a cheaper
   *  constant-rate executor instead of a ramping one. */
  flat: boolean;
}

/**
 * How a load delivers its requests. `rate` is an arrival-rate curve (open model: the engine adds
 * workers to keep up); `fixed` is a literal number of iterations fired once, which is what the
 * timeline's "Individual" shape means and which no rate can express.
 */
export type PlannedExecution =
  | { mode: "rate"; profile: RateProfile }
  | { mode: "fixed"; iterations: number; withinSeconds: number };

/** How a request body is produced at run time. Mirrors `RequestGeneratorData`, resolved to the
 *  fields an engine actually needs (the union is re-stated rather than imported so a change to
 *  the authoring model is a deliberate, visible change here too). */
export type PlannedBody =
  | { kind: "none" }
  | { kind: "randomized"; sizeBytes: number }
  | { kind: "exact"; value: string }
  | { kind: "mutate"; baseValue: string; mutationRatePercent: number };

/** Which AAS entity an operation addresses, and how it is reached over IDTA-01002. */
export interface PlannedRequest {
  /** RequestSpec id, carried through so results can be attributed back to the authored spec. */
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  /** Relative share within the owning load, as authored. */
  weight: number;
  /** Normalised cumulative upper bound in [0,1]; the engine picks with a single random draw. */
  cumulativeWeight: number;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Path relative to `PlanTarget.baseUrl`. `{id}` is substituted at run time with a base64url
   * encoded AAS identifier the engine holds in its id pool — see `idSource`.
   */
  pathTemplate: string;
  /** Query parameters appended verbatim (e.g. the page size for a collection read). */
  query: Record<string, string>;
  /** Where the `{id}` in `pathTemplate` comes from: `none` for collection endpoints, `pool` for
   *  per-entity ones, which need an identifier that actually exists on the server. */
  idSource: "none" | "pool";
  /** True when the operation removes the addressed entity, so the engine drops it from its pool
   *  instead of trying to delete it again. */
  consumesId: boolean;
  body: PlannedBody;
  /** Status codes counted as success. Anything else is an error in the run's results. */
  expectStatus: number[];
}

export interface PlannedLoad {
  /** Stable, filename/identifier-safe key unique across the plan. Also the metric tag that ties
   *  engine output back to this Load. */
  key: string;
  loadId: string;
  trackId: string;
  trackLabel: string;
  /** Human label for the run UI, e.g. "Base load · Constant 100 req/s". */
  label: string;
  shapeKind: string;
  startSeconds: number;
  execution: PlannedExecution;
  requests: PlannedRequest[];
}

export interface ExecutionPlan {
  /** Plan format version — bumped when the adapter contract changes shape. */
  version: 1;
  scenarioName: string;
  target: PlanTarget;
  totalDurationSeconds: number;
  loads: PlannedLoad[];
  /** Total requests the plan is expected to issue if the target keeps up — the integral of every
   *  rate curve plus every fixed iteration count. The same number the Compose overlay previews. */
  expectedRequests: number;
}
