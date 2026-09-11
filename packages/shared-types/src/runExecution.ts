/**
 * The wire contract for executing a timeline: what the frontend posts to `POST /api/runs`, and
 * what it gets back.
 *
 * These live in shared-types rather than in the backend so the two ends cannot drift — the same
 * reason `Connection`/`RunState`/`RunAnalysis` do. Note what is deliberately *absent*: nothing
 * here mentions k6, scripts, VUs or stages. Per ADR 0001, the engine-neutral execution plan and
 * everything below it are the backend's business; the only engine-shaped thing that crosses this
 * boundary is `engineId`, which names an adapter rather than describing one.
 */

import type { EngineId } from "./engine.ts";
import type { LoadTimelineData } from "./loadTimeline.ts";
import type { ValidationIssue } from "./loadTimelineValidation.ts";
import type { RequestOperation, RequestTargetEntity } from "./requestComposition.ts";
import type { RunState } from "./run.ts";

/** Where a run points. Sent explicitly rather than referenced by connection id: the backend does
 *  not own connections yet, and the caller already knows which target it picked. */
export interface RunTarget {
  /** API root of the AAS server, e.g. "http://localhost:8081/api/v3". */
  baseUrl: string;
  timeoutSeconds?: number;
  /** Applied to every generated request; where authentication will go once it exists. */
  headers?: Record<string, string>;
}

export interface StartRunRequest {
  /** The composed timeline, exactly as `LoadTimeline.toJSON()` serializes it. */
  timeline: LoadTimelineData;
  target: RunTarget;
  scenarioName?: string;
  /** Recorded on the run so results can be attributed to a target later. */
  connectionId?: string;
  /** Defaults to "k6", the only adapter implemented. */
  engineId?: EngineId;
  /** Compile and validate without executing — "show me what this would do". */
  dryRun?: boolean;
}

export type RunLifecycleStatus = "compiled" | "starting" | "running" | "completed" | "failed" | "stopped";

export interface RunPlanLoadSummary {
  /** Engine-side identifier; also the metric tag results are attributed to. */
  key: string;
  loadId: string;
  trackId: string;
  label: string;
  startSeconds: number;
  requestCount: number;
}

export interface RunPlanSummary {
  totalDurationSeconds: number;
  loadCount: number;
  /** Requests the plan expects to issue if the target keeps up — the integral of every rate curve
   *  plus every fixed iteration count, i.e. the same number the Compose overlay previews. */
  expectedRequests: number;
  loads: RunPlanLoadSummary[];
}

/** One request type within a {@link ConcretePlanEntry} — a row of the debug view. */
export interface ConcretePlanRequestLine {
  /** The authored RequestSpec id this line came from. */
  requestId: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  method: string;
  /** Path relative to the target base URL. `{id}` stays a placeholder — the engine substitutes a
   *  base64url-encoded identifier from its pool at run time. Any query string is included. */
  path: string;
  /** This request's share of the load, 0..1 (the authored weights, normalised). */
  share: number;
  /** Expected requests of this kind over the whole load, if the target keeps up. */
  expectedRequests: number;
}

/**
 * One compiled load — i.e. one engine scenario. Mirrors what the k6 adapter emits (see
 * `backend/src/engines/k6/compileScript.ts`): a start time, a duration, an executor, and the rate
 * or iteration count it runs at. The load's request composition is broken out into `requests`,
 * one line per authored request type with its expected total.
 */
export interface ConcretePlanEntry {
  loadId: string;
  loadKey: string;
  loadLabel: string;
  trackLabel: string;
  shapeKind: string;
  /** Offset from the start of the run at which the engine starts this load, seconds. */
  startSeconds: number;
  /** How long the executor runs, seconds. For instantaneous shapes (spike, individual) this is the
   *  window they are spread over, not the authored 0. */
  durationSeconds: number;
  /** The k6 executor this load compiles to — the only engine implemented (ADR 0001). */
  executor: "constant-arrival-rate" | "ramping-arrival-rate" | "shared-iterations";
  /** Human-readable rate profile, e.g. "constant 100 req/s", "ramp 380 → 0 req/s", "50 iterations". */
  rateSummary: string;
  /** Peak arrival rate, req/s. Absent for `shared-iterations`, which has a count, not a rate. */
  peakRatePerSec?: number;
  /** Total expected requests from this load across every request type. */
  expectedRequests: number;
  requests: ConcretePlanRequestLine[];
}

/**
 * The execution plan as a load-tool debug view: one entry per compiled load (engine scenario),
 * saying when the engine starts it, for how long, at what rate, and which IDTA-01002 calls it
 * issues. Returned by `POST /api/runs/concrete-plan`; nothing is executed to produce it.
 *
 * Request totals are expectations — the engine picks each request with a weighted random draw, so
 * the real per-request sequence varies run to run.
 */
export interface ConcretePlan {
  scenarioName: string;
  targetBaseUrl: string;
  totalDurationSeconds: number;
  /** Total the plan expects to issue if the target keeps up — the same number the Compose overlay
   *  previews and `RunPlanSummary.expectedRequests` reports. */
  expectedRequests: number;
  entries: ConcretePlanEntry[];
  /** Non-blocking issues found in the source timeline. */
  warnings: ValidationIssue[];
}

export interface RunRequestTotals {
  requests: number;
  failed: number;
  durationMsSum: number;
}

/** Server-side aggregates. Raw per-request events never cross this boundary (proposal §7.2). */
export interface RunMetrics {
  requests: number;
  failed: number;
  meanDurationMs: number;
  percentiles: { p50: number; p95: number; p99: number; max: number };
  byLoad: Record<string, RunRequestTotals>;
  /** Keyed "operation:target", e.g. "create:submodel". */
  byOperation: Record<string, RunRequestTotals>;
  byStatus: Record<string, number>;
  activeLoadKeys: string[];
}

/** The engine's own end-of-run totals, kept alongside `RunMetrics` rather than merged into it. */
export interface EngineRunSummary {
  /**
   * Every HTTP request the engine issued — **including** the handful Kaigara makes on its own
   * behalf to seed its identifier pool. It is therefore normally a little higher than
   * `RunMetrics.requests`, which counts only requests attributable to an authored load. The gap is
   * intentional: report `RunMetrics.requests` as the workload, and use this to reconcile against
   * what the engine believes it did.
   */
  requests: number;
  failed: number;
  durationMs?: { avg?: number; p95?: number; p99?: number; max?: number };
  /** Requests the engine wanted to start but could not, because its own worker pool was
   *  saturated. Non-zero means the *tool* was the bottleneck rather than the server under test,
   *  which invalidates the measurement — surface it, never bury it. */
  droppedIterations?: number;
}

export interface RunArtifactRef {
  name: string;
  description: string;
  contentType: string;
}

/** Everything known about one run. Fetched from `GET /api/runs/:id` and pushed over the SSE
 *  stream at `GET /api/runs/:id/events`. */
export interface RunView {
  id: string;
  status: RunLifecycleStatus;
  scenarioName: string;
  connectionId: string;
  engineId: EngineId;
  targetBaseUrl: string;
  createdAt: string;
  endedAt?: string;
  /** Projection onto the shape the Run screen already renders. */
  state: RunState;
  plan: RunPlanSummary;
  metrics: RunMetrics;
  /** Non-blocking issues found in the source timeline — why a run may not do what was expected. */
  warnings: ValidationIssue[];
  engineSummary?: EngineRunSummary;
  /** Generated inputs (the engine script, the plan) readable via
   *  `GET /api/runs/:id/artifacts/:name`, so the timeline-to-requests translation is inspectable. */
  artifacts: RunArtifactRef[];
  engineLog: string[];
  error?: string;
}

export interface EngineDescriptorView {
  id: EngineId;
  name: string;
  available: boolean;
  version?: string;
  detail: string;
}
